import http from 'http';
import os from 'os';
import { WebSocketServer } from 'ws';
import logger from '../logger.mjs';
import { PageActions } from '../cdp/page-actions.mjs';

/**
 * Get local IPv4 address on the LAN.
 */
export function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Dual-Mode H5 Web Server: Discrete Big-Button Fine-Tuner & Live Remote Screencast.
 */
export class H5Server {
  /**
   * @param {object} options
   * @param {number} [options.port=3000]
   * @param {string} [options.publicUrl='']
   * @param {import('../cdp/browser-manager.mjs').BrowserManager} options.browserManager
   * @param {import('../engine/scheduler.mjs').Scheduler} options.scheduler
   * @param {import('../feishu/notifier.mjs').FeishuNotifier} [options.notifier]
   */
  constructor({ port = 3000, publicUrl = '', browserManager, scheduler, notifier }) {
    this.port = port;
    this.publicUrl = publicUrl;
    this.browserManager = browserManager;
    this.scheduler = scheduler;
    this.notifier = notifier;
    this.server = null;
    this.wss = null;
    this.cdpSession = null;
    this.activeClients = new Set();
    this.currentCaptchaBuffer = null;
    this.lastPercent = 45.0;
    this.isScreencasting = false;
  }

  /**
   * Get the public or LAN URL for the H5 captcha panel.
   */
  getUrl() {
    if (this.publicUrl && this.publicUrl.trim().length > 0) {
      return this.publicUrl.replace(/\/$/, '') + '/captcha';
    }
    const localIp = getLocalIp();
    return `http://${localIp}:${this.port}/captcha`;
  }

  /**
   * Update the latest captcha screenshot buffer stored in server memory.
   * @param {Buffer} buffer
   */
  setCaptchaBuffer(buffer) {
    this.currentCaptchaBuffer = buffer;
  }

  /**
   * Start the HTTP and WebSocket streaming server.
   */
  async start() {
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        try {
          if (url.pathname === '/captcha' || url.pathname === '/' || url.pathname === '/tuner') {
            this.handleServeH5(req, res);
          } else if (url.pathname === '/api/captcha-state') {
            await this.handleGetState(req, res);
          } else if (url.pathname === '/api/drag-hold' && req.method === 'POST') {
            await this.handleDragHold(req, res);
          } else if (url.pathname === '/api/release-slide' && req.method === 'POST') {
            await this.handleReleaseSlide(req, res);
          } else if (url.pathname === '/api/cancel-drag' && req.method === 'POST') {
            await this.handleCancelDrag(req, res);
          } else if (url.pathname === '/api/submit-slide' && req.method === 'POST') {
            await this.handleSubmitSlide(req, res);
          } else if (url.pathname === '/api/refresh-captcha' && req.method === 'POST') {
            await this.handleRefreshCaptcha(req, res);
          } else if (url.pathname === '/api/wake-modal' && req.method === 'POST') {
            await this.handleWakeModal(req, res);
          } else if (url.pathname === '/api/check-status') {
            await this.handleCheckStatus(req, res);
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
          }
        } catch (err) {
          logger.error(`[H5Server] Request error on ${url.pathname}: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // Attach WebSocket Server for optional live screencast & input streaming
      this.wss = new WebSocketServer({ server: this.server, path: '/stream' });
      this.setupWebSocketHandlers();

      this.server.listen(this.port, '0.0.0.0', () => {
        const h5Url = this.getUrl();
        logger.success(`[H5Server] Interactive Hold-and-Release Tuner listening on ${h5Url}`);
        resolve(true);
      });

      this.server.on('error', (err) => {
        logger.warn(`[H5Server] Server error on port ${this.port}: ${err.message}`);
        resolve(false);
      });
    });
  }

  /**
   * Setup WebSocket connection for optional live screencasting.
   */
  setupWebSocketHandlers() {
    this.wss.on('connection', async (ws) => {
      this.activeClients.add(ws);
      try {
        await this.ensureCdpScreencast();
      } catch (err) {
        logger.warn(`[H5Server] Failed to start CDP screencast: ${err.message}`);
      }

      ws.on('message', async (message) => {
        try {
          const msg = JSON.parse(message.toString());
          await this.handleClientMessage(msg, ws);
        } catch (err) {
          logger.warn(`[H5Server] Error handling WS message: ${err.message}`);
        }
      });

      ws.on('close', () => {
        this.activeClients.delete(ws);
        if (this.activeClients.size === 0) {
          this.stopCdpScreencast().catch(() => {});
        }
      });

      ws.on('error', (err) => {
        logger.warn(`[H5Server] WS Client error: ${err.message}`);
      });
    });
  }

  /**
   * Initialize or reuse CDP session for screencasting.
   */
  async ensureCdpScreencast() {
    if (this.isScreencasting && this.cdpSession) {
      return;
    }

    const page = await this.browserManager.getPrimaryPage();
    if (!page) return;

    if (!this.cdpSession) {
      this.cdpSession = await page.context().newCDPSession(page);
      this.cdpSession.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
        try {
          await this.cdpSession.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        } catch {}

        if (this.activeClients.size > 0) {
          const payload = JSON.stringify({ type: 'frame', data, metadata });
          for (const client of this.activeClients) {
            if (client.readyState === 1) {
              client.send(payload);
            }
          }
        }
      });
    }

    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    this.isScreencasting = true;
  }

  /**
   * Stop CDP screencast.
   */
  async stopCdpScreencast() {
    if (this.cdpSession && this.isScreencasting) {
      try {
        await this.cdpSession.send('Page.stopScreencast').catch(() => {});
      } catch {}
      this.isScreencasting = false;
    }
  }

  /**
   * Handle incoming messages from WS.
   */
  async handleClientMessage(msg, ws) {
    if (msg.type === 'slide') {
      const percent = Number(msg.percent) || 45;
      const page = await this.browserManager.getPrimaryPage();
      const dragResult = await PageActions.executeSlideDrag(page, percent);
      ws.send(JSON.stringify({
        type: 'slide_result',
        success: dragResult.success,
        message: dragResult.message,
      }));
    }
  }

  /**
   * Stop the HTTP & WebSocket server.
   */
  async stop() {
    await this.stopCdpScreencast();
    if (this.cdpSession) {
      try { await this.cdpSession.detach(); } catch {}
      this.cdpSession = null;
    }
    if (this.wss) {
      this.wss.close();
    }
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('[H5Server] Web Server stopped.');
          resolve();
        });
      });
    }
  }

  /**
   * Get latest captcha state.
   */
  async handleGetState(req, res) {
    try {
      let base64 = null;
      let active = false;

      const page = await this.browserManager.getPrimaryPage();
      const cap = await PageActions.checkAndCaptureCaptcha(page);

      const buf = cap.buffer || cap.rawBuffer || this.currentCaptchaBuffer;
      if (buf) {
        this.currentCaptchaBuffer = buf;
        base64 = buf.toString('base64');
        active = true;
      }

      const isRunning = await PageActions.isInstanceRunning(page);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(JSON.stringify({
        active,
        isRunning,
        isHolding: PageActions.dragSession.active,
        heldPercent: PageActions.dragSession.currentPercent || this.lastPercent,
        imageBase64: base64,
        lastPercent: this.lastPercent,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Handle drag and HOLD without releasing.
   */
  async handleDragHold(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const percent = Math.max(0, Math.min(100, Number(data.percent) || 45));
        this.lastPercent = percent;

        const page = await this.browserManager.getPrimaryPage();
        const holdRes = await PageActions.dragAndHold(page, percent);

        let imageBase64 = null;
        if (holdRes.buffer) {
          this.currentCaptchaBuffer = holdRes.buffer;
          imageBase64 = holdRes.buffer.toString('base64');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: holdRes.success,
          holding: true,
          percent,
          message: holdRes.message || '滑块已移至目标位置并处于按住状态，请确认对齐后松开。',
          imageBase64,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  /**
   * Handle user confirming release of held slider.
   */
  async handleReleaseSlide(req, res) {
    try {
      const page = await this.browserManager.getPrimaryPage();
      const resRelease = await PageActions.releaseSlider(page);

      const targetUser = this.notifier?.config?.feishu?.adminUserIds?.[0];

      let newImageBase64 = null;
      if (resRelease.newCaptchaBuffer) {
        this.currentCaptchaBuffer = resRelease.newCaptchaBuffer;
        newImageBase64 = resRelease.newCaptchaBuffer.toString('base64');
      }

      if (resRelease.success) {
        this.currentCaptchaBuffer = null;
        if (this.notifier && this.notifier.enabled) {
          await this.notifier.sendText(
            `🎉 电脑端滑块验证成功！ModelScope 实例连接成功，PC 守护进程已自动接管保活！`,
            targetUser
          ).catch(() => {});
        }
        if (this.scheduler) {
          this.scheduler.runRound().catch(() => {});
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: resRelease.success,
        message: resRelease.message,
        newImageBase64,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Handle cancel/reset drag.
   */
  async handleCancelDrag(req, res) {
    try {
      const page = await this.browserManager.getPrimaryPage();
      const cap = await PageActions.cancelDrag(page);
      const buf = cap.buffer || cap.rawBuffer;
      let imageBase64 = null;
      if (buf) {
        this.currentCaptchaBuffer = buf;
        imageBase64 = buf.toString('base64');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: '已释放滑块并刷新验证码',
        imageBase64,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Handle wake modal & trigger captcha on PC.
   */
  async handleWakeModal(req, res) {
    try {
      const page = await this.browserManager.getPrimaryPage();
      const nbConfig = this.scheduler?.config?.notebooks?.[0] || { name: 'ModelScope工作空间', instanceType: 'CPU' };

      const connectBtn = await page.$('button:has-text("连接运行时"), div[role="button"]:has-text("连接运行时"), a:has-text("连接运行时")');
      if (connectBtn && (await connectBtn.isVisible())) {
        await page.evaluate(el => el.click(), connectBtn).catch(async () => {
          await connectBtn.click({ force: true, timeout: 3000 });
        });
        await PageActions.sleep(1500);
      }

      const modalRes = await PageActions.handleSelectInstanceModal(page, nbConfig, { forceStart: true });
      const cap = await PageActions.checkAndCaptureCaptcha(page);
      const buf = cap.buffer || cap.rawBuffer || modalRes.captchaBuffer;

      let imageBase64 = null;
      if (buf) {
        this.currentCaptchaBuffer = buf;
        imageBase64 = buf.toString('base64');
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: imageBase64 ? '已成功唤起验证码！' : '正在连接或已处于运行状态。',
        imageBase64,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Check running status.
   */
  async handleCheckStatus(req, res) {
    try {
      const page = await this.browserManager.getPrimaryPage();
      const running = await PageActions.isInstanceRunning(page);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        running,
        message: running ? '🎉 实例处于运行中，PC 守护进程正持续保活！' : '实例尚未连接，请点击连接或完成滑动。',
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Handle slide execution submitted from H5.
   */
  async handleSubmitSlide(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const percent = Math.max(0, Math.min(100, Number(data.percent) || 45));
        this.lastPercent = percent;

        logger.info(`[H5Server] Received button slide command from phone: ${percent.toFixed(1)}%`);

        const page = await this.browserManager.getPrimaryPage();
        const dragResult = await PageActions.executeSlideDrag(page, percent);

        const targetUser = this.notifier?.config?.feishu?.adminUserIds?.[0];

        let postDragBase64 = null;
        if (dragResult.postDragBuffer) {
          postDragBase64 = dragResult.postDragBuffer.toString('base64');
        }

        if (dragResult.success) {
          this.currentCaptchaBuffer = null;
          if (this.notifier && this.notifier.enabled) {
            await this.notifier.sendText(
              `🎉 电脑端滑动验证通过 (${percent.toFixed(1)}%)！ModelScope 实例连接成功！`,
              targetUser
            ).catch(() => {});
          }
          if (this.scheduler) {
            this.scheduler.runRound().catch(() => {});
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: '🎉 验证通过！ModelScope 实例连接成功！',
            postDragBase64,
          }));
        } else {
          let newImage = null;
          if (dragResult.newCaptchaBuffer) {
            this.currentCaptchaBuffer = dragResult.newCaptchaBuffer;
            newImage = dragResult.newCaptchaBuffer.toString('base64');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: '验证未通过，请查看下方电脑端实际落点，微调百分比后再次提交。',
            postDragBase64,
            newImageBase64: newImage,
          }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  /**
   * Handle refresh captcha from H5.
   */
  async handleRefreshCaptcha(req, res) {
    try {
      const page = await this.browserManager.getPrimaryPage();
      const cap = await PageActions.refreshCaptcha(page);
      const buf = cap.buffer || cap.rawBuffer;
      if (buf) {
        this.currentCaptchaBuffer = buf;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(JSON.stringify({
          success: true,
          imageBase64: buf.toString('base64'),
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          message: '未检测到验证码，可能已处于运行状态。',
        }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Serve the responsive mobile-first discrete button tuner H5 application.
   */
  handleServeH5(req, res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>ModelScope 移动端辅助微调</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html, body {
      width: 100%;
      min-height: 100%;
      background-color: #0b0f19;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    .container {
      max-width: 500px;
      margin: 0 auto;
      padding: 12px 14px 40px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #1f2937;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand h1 {
      font-size: 15px;
      font-weight: 700;
      color: #f1f5f9;
    }
    .status-badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.3);
      display: flex;
      align-items: center;
      gap: 5px;
      font-weight: 500;
    }
    .top-actions {
      display: flex;
      gap: 8px;
    }
    .top-btn {
      flex: 1;
      height: 38px;
      border-radius: 8px;
      border: 1px solid #374151;
      background: #1f2937;
      color: #e2e8f0;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }
    .top-btn:active {
      background: #374151;
    }
    .card {
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 12px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 600;
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .image-container {
      width: 100%;
      background: #000;
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 160px;
      position: relative;
      border: 1px solid #334155;
    }
    .image-container img {
      width: 100%;
      height: auto;
      display: block;
      object-fit: contain;
    }
    .placeholder-text {
      color: #64748b;
      font-size: 13px;
      text-align: center;
      padding: 20px;
    }
    .value-display-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #1e293b;
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid #334155;
    }
    .value-label {
      font-size: 13px;
      color: #94a3b8;
    }
    .value-number {
      font-size: 22px;
      font-weight: 800;
      color: #38bdf8;
      letter-spacing: 0.5px;
    }
    .btn-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }
    .preset-btn {
      height: 42px;
      background: #1e293b;
      border: 1px solid #334155;
      color: #f1f5f9;
      font-size: 14px;
      font-weight: 700;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.1s;
    }
    .preset-btn:active {
      transform: scale(0.95);
      background: #3b82f6;
      border-color: #60a5fa;
    }
    .preset-btn.selected {
      background: #2563eb;
      border-color: #60a5fa;
      color: #fff;
      box-shadow: 0 0 10px rgba(37, 99, 235, 0.5);
    }
    .step-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 6px;
    }
    .step-btn {
      height: 38px;
      background: #1e293b;
      border: 1px solid #334155;
      color: #e2e8f0;
      font-size: 11px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .step-btn:active {
      background: #475569;
    }
    .slider-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 0;
    }
    input[type="range"] {
      flex: 1;
      height: 6px;
      border-radius: 3px;
      background: #334155;
      outline: none;
      -webkit-appearance: none;
    }
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #38bdf8;
      cursor: pointer;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.8);
    }
    .action-row {
      display: flex;
      gap: 10px;
    }
    .btn-release {
      flex: 3;
      height: 50px;
      background: linear-gradient(135deg, #10b981, #059669);
      color: #fff;
      font-size: 15px;
      font-weight: 700;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4);
      transition: all 0.15s;
    }
    .btn-release:active {
      transform: scale(0.98);
    }
    .btn-cancel {
      flex: 1;
      height: 50px;
      background: #374151;
      color: #fca5a5;
      font-size: 13px;
      font-weight: 600;
      border: 1px solid #4b5563;
      border-radius: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .btn-cancel:active {
      background: #4b5563;
    }
    .option-card {
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .link-btn {
      color: #38bdf8;
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 10px;
      background: rgba(56, 189, 248, 0.1);
      border-radius: 6px;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .result-box {
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      display: none;
    }
    .result-box.success {
      display: block;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: #4ade80;
    }
    .result-box.error {
      display: block;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
    }
    .toast {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.95);
      color: #fff;
      padding: 8px 16px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid rgba(255,255,255,0.15);
      backdrop-filter: blur(10px);
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      z-index: 100;
      opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s ease;
      pointer-events: none;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(5px);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <span style="font-size: 18px;">📱</span>
        <h1>ModelScope 辅助微调面板</h1>
      </div>
      <div class="status-badge" id="statusBadge">
        <span>🟢</span> <span id="statusText">就绪</span>
      </div>
    </header>

    <div class="option-card">
      <div style="font-size: 12px; color: #cbd5e1;">
        <span>🌐 方案 1：手机直达原生滑动</span>
      </div>
      <a href="https://www.modelscope.cn/code/workspace" target="_blank" class="link-btn">
        打开官网 (开启电脑模式) ↗
      </a>
    </div>

    <div class="top-actions">
      <button class="top-btn" id="btnWakeModal">
        <span>⚡</span> 唤起连接验证码
      </button>
      <button class="top-btn" id="btnRefresh">
        <span>🔄</span> 刷新图片
      </button>
      <button class="top-btn" id="btnCheck">
        <span>✅</span> 检查状态
      </button>
    </div>

    <div class="card">
      <div class="card-title">
        <span>📸 验证码实时图片 (滑块按住中 🔒)</span>
        <span style="font-size: 11px; color: #38bdf8;" id="fetchTime">实时同步</span>
      </div>
      <div class="image-container" id="imageContainer">
        <div class="placeholder-text" id="placeholderText">正在获取最新验证码图片...</div>
        <img id="captchaImg" style="display: none;" alt="Captcha" />
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>🎯 方案 2：轻点按键精准微调（按住不放开）</span>
      </div>

      <div class="value-display-bar">
        <span class="value-label">当前按住位置</span>
        <span class="value-number" id="valDisplay">45.0%</span>
      </div>

      <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">
        ⚡ 快捷预设（点击后滑块在电脑端移动并持续按住）：
      </div>
      <div class="btn-grid">
        <button class="preset-btn" data-val="35">35%</button>
        <button class="preset-btn" data-val="40">40%</button>
        <button class="preset-btn" data-val="43">43%</button>
        <button class="preset-btn selected" data-val="45">45%</button>
        <button class="preset-btn" data-val="48">48%</button>
        <button class="preset-btn" data-val="50">50%</button>
        <button class="preset-btn" data-val="52">52%</button>
        <button class="preset-btn" data-val="55">55%</button>
        <button class="preset-btn" data-val="58">58%</button>
        <button class="preset-btn" data-val="60">60%</button>
        <button class="preset-btn" data-val="65">65%</button>
        <button class="preset-btn" data-val="70">70%</button>
      </div>

      <div style="font-size: 11px; color: #94a3b8; margin-top: 6px;">
        🔍 步进微调按键（移动并刷新实时图片）：
      </div>
      <div class="step-grid">
        <button class="step-btn" data-step="-5">-5%</button>
        <button class="step-btn" data-step="-1">-1%</button>
        <button class="step-btn" data-step="-0.5">-0.5%</button>
        <button class="step-btn" data-step="0.5">+0.5%</button>
        <button class="step-btn" data-step="1">+1%</button>
        <button class="step-btn" data-step="5">+5%</button>
      </div>

      <div class="slider-row">
        <span style="font-size: 11px; color: #64748b;">0%</span>
        <input type="range" id="percentSlider" min="0" max="100" step="0.5" value="45" />
        <span style="font-size: 11px; color: #64748b;">100%</span>
      </div>

      <div class="action-row">
        <button class="btn-release" id="btnRelease">
          <span>✅</span> 确认对齐，放开滑块 (<span id="btnVal">45.0%</span>)
        </button>
        <button class="btn-cancel" id="btnCancel">
          重置
        </button>
      </div>

      <div class="result-box" id="resultBox"></div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let currentPercent = 45.0;
    let isHolding = false;

    const captchaImg = document.getElementById('captchaImg');
    const placeholderText = document.getElementById('placeholderText');
    const valDisplay = document.getElementById('valDisplay');
    const btnVal = document.getElementById('btnVal');
    const percentSlider = document.getElementById('percentSlider');
    const btnRelease = document.getElementById('btnRelease');
    const btnCancel = document.getElementById('btnCancel');
    const btnRefresh = document.getElementById('btnRefresh');
    const btnWakeModal = document.getElementById('btnWakeModal');
    const btnCheck = document.getElementById('btnCheck');
    const resultBox = document.getElementById('resultBox');
    const toast = document.getElementById('toast');
    const fetchTime = document.getElementById('fetchTime');
    const presetBtns = document.querySelectorAll('.preset-btn');
    const stepBtns = document.querySelectorAll('.step-btn');

    function showToast(msg, duration = 2000) {
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), duration);
    }

    async function applyPercent(val) {
      currentPercent = Math.max(0, Math.min(100, Math.round(Number(val) * 10) / 10));
      valDisplay.textContent = currentPercent.toFixed(1) + '%';
      btnVal.textContent = currentPercent.toFixed(1) + '%';
      percentSlider.value = currentPercent;

      presetBtns.forEach(b => {
        if (Math.abs(Number(b.dataset.val) - currentPercent) < 0.3) {
          b.classList.add('selected');
        } else {
          b.classList.remove('selected');
        }
      });

      // Move and hold in Chrome, then update live image!
      try {
        const res = await fetch('/api/drag-hold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ percent: currentPercent })
        });
        const data = await res.json();
        if (data.imageBase64) {
          captchaImg.src = 'data:image/png;base64,' + data.imageBase64;
          captchaImg.style.display = 'block';
          placeholderText.style.display = 'none';
          fetchTime.textContent = new Date().toLocaleTimeString();
        }
      } catch (e) {}
    }

    presetBtns.forEach(b => {
      b.addEventListener('click', () => {
        applyPercent(Number(b.dataset.val));
      });
    });

    stepBtns.forEach(b => {
      b.addEventListener('click', () => {
        const step = Number(b.dataset.step);
        applyPercent(currentPercent + step);
      });
    });

    percentSlider.addEventListener('change', (e) => {
      applyPercent(Number(e.target.value));
    });

    async function loadCaptchaState() {
      try {
        const res = await fetch('/api/captcha-state');
        const data = await res.json();
        if (data.imageBase64) {
          captchaImg.src = 'data:image/png;base64,' + data.imageBase64;
          captchaImg.style.display = 'block';
          placeholderText.style.display = 'none';
          fetchTime.textContent = new Date().toLocaleTimeString();
        } else if (data.isRunning) {
          placeholderText.textContent = '🎉 ModelScope 实例已处于运行状态！PC 守护进程正持续保活。';
          placeholderText.style.display = 'block';
          captchaImg.style.display = 'none';
        } else {
          placeholderText.textContent = '未检测到验证码弹窗。请点击上方【⚡ 唤起连接验证码】。';
          placeholderText.style.display = 'block';
          captchaImg.style.display = 'none';
        }
      } catch (err) {
        placeholderText.textContent = '连接服务异常: ' + err.message;
      }
    }

    btnRefresh.addEventListener('click', async () => {
      showToast('正在刷新验证码...');
      try {
        const res = await fetch('/api/refresh-captcha', { method: 'POST' });
        const data = await res.json();
        if (data.imageBase64) {
          captchaImg.src = 'data:image/png;base64,' + data.imageBase64;
          captchaImg.style.display = 'block';
          placeholderText.style.display = 'none';
          showToast('验证码刷新成功！');
        } else {
          showToast(data.message || '刷新完成');
        }
      } catch (err) {
        showToast('刷新异常: ' + err.message);
      }
    });

    btnWakeModal.addEventListener('click', async () => {
      showToast('正在电脑端点击连接实例并获取验证码...');
      try {
        const res = await fetch('/api/wake-modal', { method: 'POST' });
        const data = await res.json();
        if (data.imageBase64) {
          captchaImg.src = 'data:image/png;base64,' + data.imageBase64;
          captchaImg.style.display = 'block';
          placeholderText.style.display = 'none';
          showToast('成功获取验证码！');
        } else {
          showToast(data.message || '操作已执行');
          loadCaptchaState();
        }
      } catch (err) {
        showToast('操作失败: ' + err.message);
      }
    });

    btnCheck.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/check-status');
        const data = await res.json();
        showToast(data.message, 3000);
        if (data.running) {
          resultBox.className = 'result-box success';
          resultBox.textContent = '🎉 实例已在云端正常运行！PC 守护进程正全天候自动保活。';
        }
      } catch (err) {
        showToast('检查失败: ' + err.message);
      }
    });

    btnCancel.addEventListener('click', async () => {
      showToast('正在重置滑块...');
      try {
        const res = await fetch('/api/cancel-drag', { method: 'POST' });
        const data = await res.json();
        if (data.imageBase64) {
          captchaImg.src = 'data:image/png;base64,' + data.imageBase64;
          captchaImg.style.display = 'block';
        }
        showToast('已重置');
      } catch (err) {
        showToast('重置异常: ' + err.message);
      }
    });

    btnRelease.addEventListener('click', async () => {
      btnRelease.classList.add('loading');
      btnRelease.textContent = '正在电脑端释放滑块提交 (' + currentPercent.toFixed(1) + '%)...';
      resultBox.style.display = 'none';

      try {
        const res = await fetch('/api/release-slide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();

        if (data.success) {
          resultBox.className = 'result-box success';
          resultBox.textContent = data.message || '🎉 验证通过！ModelScope 实例连接成功！';
          showToast('🎉 验证通过！', 3000);
        } else {
          resultBox.className = 'result-box error';
          resultBox.textContent = '⚠️ ' + (data.message || '验证未通过，请重新微调后重试。');
          showToast('验证未通过，请重试');
          if (data.newImageBase64) {
            captchaImg.src = 'data:image/png;base64,' + data.newImageBase64;
          }
        }
      } catch (err) {
        resultBox.className = 'result-box error';
        resultBox.textContent = '释放滑块异常: ' + err.message;
      } finally {
        btnRelease.classList.remove('loading');
        btnRelease.innerHTML = '<span>✅</span> 确认对齐，放开滑块 (<span id="btnVal">' + currentPercent.toFixed(1) + '%</span>)';
      }
    });

    loadCaptchaState();
  </script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

export default H5Server;
