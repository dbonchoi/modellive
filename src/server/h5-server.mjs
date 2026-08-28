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
 * Live Remote Control & Screencast Web Server for Real-Time Mobile Chrome Interaction.
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
    this.lastPercent = 50;
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
          if (url.pathname === '/captcha' || url.pathname === '/' || url.pathname === '/live') {
            this.handleServeH5(req, res);
          } else if (url.pathname === '/api/captcha-state') {
            await this.handleGetState(req, res);
          } else if (url.pathname === '/api/submit-slide' && req.method === 'POST') {
            await this.handleSubmitSlide(req, res);
          } else if (url.pathname === '/api/refresh-captcha' && req.method === 'POST') {
            await this.handleRefreshCaptcha(req, res);
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

      // Attach WebSocket Server for Real-Time Low-Latency Screencast & Input Streaming
      this.wss = new WebSocketServer({ server: this.server, path: '/stream' });
      this.setupWebSocketHandlers();

      this.server.listen(this.port, '0.0.0.0', () => {
        const h5Url = this.getUrl();
        logger.success(`[H5Server] Live Screencast Remote Control Server listening on ${h5Url}`);
        resolve(true);
      });

      this.server.on('error', (err) => {
        logger.warn(`[H5Server] Server error on port ${this.port}: ${err.message}`);
        resolve(false);
      });
    });
  }

  /**
   * Setup WebSocket connection and CDP screencast bridge.
   */
  setupWebSocketHandlers() {
    this.wss.on('connection', async (ws) => {
      this.activeClients.add(ws);
      logger.info(`[H5Server] Mobile client connected to Live Stream (Active clients: ${this.activeClients.size})`);

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
        logger.info(`[H5Server] Mobile client disconnected (Active clients: ${this.activeClients.size})`);
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
    if (!page) {
      logger.warn('[H5Server] No primary page available for screencast.');
      return;
    }

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

    logger.info('[H5Server] Starting 30FPS CDP Live Screencast...');
    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 85,
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
      logger.info('[H5Server] Stopped CDP Screencast (no active viewers).');
    }
  }

  /**
   * Handle incoming touch/mouse input events from mobile browser.
   */
  async handleClientMessage(msg, ws) {
    if (!this.cdpSession) return;

    if (msg.type === 'input') {
      const { event, x, y, buttons } = msg;
      try {
        if (event === 'mousedown') {
          await this.cdpSession.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: Math.round(x),
            y: Math.round(y),
            button: 'left',
            clickCount: 1,
          });
        } else if (event === 'mousemove') {
          await this.cdpSession.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: Math.round(x),
            y: Math.round(y),
            button: 'left',
            buttons: buttons !== undefined ? buttons : 1,
          });
        } else if (event === 'mouseup') {
          await this.cdpSession.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: Math.round(x),
            y: Math.round(y),
            button: 'left',
          });

          // Check if captcha is passed after mouse release
          setTimeout(async () => {
            try {
              const page = await this.browserManager.getPrimaryPage();
              const cap = await PageActions.checkAndCaptureCaptcha(page);
              if (!cap.visible) {
                ws.send(JSON.stringify({ type: 'status', passed: true, message: '🎉 验证通过！实例正在继续连接运行...' }));
                if (this.notifier) {
                  this.notifier.sendText(
                    '🎉 ModelScope 实例已在手机实时远程操作中完成验证并成功连接！',
                    this.notifier.config?.feishu?.adminUserIds?.[0]
                  ).catch(() => {});
                }
              }
            } catch {}
          }, 1500);
        } else if (event === 'click') {
          // Dedicated click event: press then release
          await this.cdpSession.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: Math.round(x),
            y: Math.round(y),
            button: 'left',
            clickCount: 1,
          });
          await PageActions.sleep(80);
          await this.cdpSession.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: Math.round(x),
            y: Math.round(y),
            button: 'left',
          });
        }
      } catch (err) {
        logger.warn(`[H5Server] Failed to dispatch mouse event: ${err.message}`);
      }
    } else if (msg.type === 'click_connect') {
      try {
        const page = await this.browserManager.getPrimaryPage();
        const nbConfig = this.scheduler?.config?.notebooks?.[0] || { name: 'ModelScope', instanceType: 'CPU' };

        // 1. Click "连接运行时" button if present
        const connectBtn = await page.$('button:has-text("连接运行时"), div[role="button"]:has-text("连接运行时"), a:has-text("连接运行时")');
        if (connectBtn && (await connectBtn.isVisible())) {
          logger.info('[H5Server] Auto-clicking "连接运行时" button...');
          await page.evaluate(el => el.click(), connectBtn).catch(async () => {
            await connectBtn.click({ force: true, timeout: 3000 });
          });
          await PageActions.sleep(1500);
        }

        // 2. Handle "选择实例" modal and click "连接"
        const modalRes = await PageActions.handleSelectInstanceModal(page, nbConfig, { forceStart: true });
        ws.send(JSON.stringify({
          type: 'toast',
          message: modalRes.captchaBuffer ? '已唤起安全验证码！' : '正在连接实例...',
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'toast', message: `操作异常: ${err.message}` }));
      }
    } else if (msg.type === 'refresh') {
      try {
        const page = await this.browserManager.getPrimaryPage();
        await PageActions.refreshCaptcha(page);
        ws.send(JSON.stringify({ type: 'toast', message: '已刷新验证码图片' }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'toast', message: `刷新失败: ${err.message}` }));
      }
    } else if (msg.type === 'check') {
      try {
        const page = await this.browserManager.getPrimaryPage();
        const cap = await PageActions.checkAndCaptureCaptcha(page);
        ws.send(JSON.stringify({
          type: 'status',
          passed: !cap.visible,
          message: !cap.visible ? '🎉 验证已完成，实例正在运行中！' : '验证尚未通过，请拖动滑块完成拼图。',
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'status', passed: false, message: err.message }));
      }
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
   * Get latest captcha state (Fallback API).
   */
  async handleGetState(req, res) {
    try {
      let base64 = null;
      let active = false;

      const page = await this.browserManager.getPrimaryPage();
      const cap = await PageActions.checkAndCaptureCaptcha(page);

      const buf = cap.rawBuffer || cap.buffer || this.currentCaptchaBuffer;
      if (buf) {
        this.currentCaptchaBuffer = buf;
        base64 = buf.toString('base64');
        active = true;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(JSON.stringify({
        active,
        imageBase64: base64,
        lastPercent: this.lastPercent,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Handle slide execution submitted from H5 (Fallback mode).
   */
  async handleSubmitSlide(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const percent = Math.max(0, Math.min(100, Number(data.percent) || 50));
        this.lastPercent = percent;

        logger.info(`[H5Server] Received slide command from phone: ${percent.toFixed(1)}%`);

        const page = await this.browserManager.getPrimaryPage();
        const dragResult = await PageActions.executeSlideDrag(page, percent);

        if (dragResult.success) {
          this.currentCaptchaBuffer = null;
          if (this.notifier && this.notifier.enabled) {
            const targetUser = this.notifier.config?.feishu?.adminUserIds?.[0];
            if (dragResult.postDragBuffer) {
              await this.notifier.sendImageCard(
                dragResult.postDragBuffer,
                `✅ 电脑端滑动执行完成 (设定值: ${percent.toFixed(1)}%)`,
                `🎉 **验证通过**！滑块已准确拖拽到位，ModelScope 实例已成功连接运行！`,
                targetUser,
                'green'
              ).catch(() => {});
            } else {
              await this.notifier.sendText(
                `🎉 电脑端滑动验证通过 (${percent.toFixed(1)}%)！ModelScope 实例连接成功！`,
                targetUser
              ).catch(() => {});
            }
          }
          if (this.scheduler) {
            this.scheduler.runRound().catch(() => {});
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: '🎉 验证通过！ModelScope 实例连接成功！',
          }));
        } else {
          if (this.notifier && this.notifier.enabled) {
            const targetUser = this.notifier.config?.feishu?.adminUserIds?.[0];
            const feedbackImg = dragResult.postDragBuffer || dragResult.newCaptchaBuffer;
            if (feedbackImg) {
              await this.notifier.sendCaptchaCard(
                feedbackImg,
                targetUser,
                `⚠️ 电脑端已滑动至 **${percent.toFixed(1)}%**，但验证未通过。\n📸 **上图为电脑端实际拖拽落点**，请根据落点微调后在手机 H5 上再次尝试：`
              ).catch(() => {});
            }
          }

          let newImage = null;
          if (dragResult.newCaptchaBuffer) {
            this.currentCaptchaBuffer = dragResult.newCaptchaBuffer;
            newImage = dragResult.newCaptchaBuffer.toString('base64');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: '验证未通过，电脑端实际落点已同步发送至飞书。请在手机上微调后再次提交。',
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
      const buf = cap.rawBuffer || cap.buffer;
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
          message: '未检测到验证码，可能已自动通过。',
        }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * Serve the responsive mobile-first live remote control H5 application.
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
  <title>ModelScope 远程实时操控</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; touch-action: none; }
    html, body {
      width: 100%;
      height: 100%;
      height: 100dvh;
      overflow: hidden;
      background-color: #0b0f19;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
    }
    header {
      width: 100%;
      padding: 10px 14px;
      background: #111827;
      border-bottom: 1px solid #1f2937;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 10;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
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
    .status-badge.offline {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.3);
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      animation: pulse 1.5s infinite;
    }
    .status-badge.offline .status-dot {
      background: #ef4444;
      animation: none;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); opacity: 0.8; }
      50% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(0.95); opacity: 0.8; }
    }
    .btn-icon {
      background: #1f2937;
      border: 1px solid #374151;
      color: #e2e8f0;
      padding: 4px 10px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .btn-icon.active {
      background: #2563eb;
      border-color: #3b82f6;
      color: #fff;
    }
    .viewport-container {
      flex: 1;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      background: #000;
      overflow: hidden;
    }
    canvas#screencast {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6);
      cursor: crosshair;
    }
    .touch-cursor {
      position: absolute;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(59, 130, 246, 0.35);
      border: 2px solid #60a5fa;
      pointer-events: none;
      transform: translate(-50%, -50%);
      display: none;
      z-index: 5;
      box-shadow: 0 0 12px rgba(59, 130, 246, 0.8);
    }
    .quick-bar {
      position: absolute;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.88);
      backdrop-filter: blur(10px);
      padding: 5px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.15);
      display: flex;
      align-items: center;
      gap: 8px;
      z-index: 8;
      box-shadow: 0 4px 15px rgba(0,0,0,0.4);
    }
    .quick-btn {
      background: rgba(255,255,255,0.1);
      border: none;
      color: #f1f5f9;
      font-size: 12px;
      font-weight: 500;
      padding: 3px 8px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .quick-btn:active {
      background: rgba(255,255,255,0.25);
    }
    footer {
      width: 100%;
      padding: 10px 14px env(safe-area-inset-bottom, 10px);
      background: #111827;
      border-top: 1px solid #1f2937;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 10;
    }
    .footer-row {
      width: 100%;
      display: flex;
      gap: 8px;
    }
    .btn {
      flex: 1;
      height: 42px;
      border-radius: 10px;
      border: none;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      transition: all 0.15s ease;
      touch-action: manipulation;
    }
    .btn:active {
      transform: scale(0.97);
    }
    .btn-secondary {
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid #334155;
    }
    .btn-primary {
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #fff;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
    }
    .btn-accent {
      background: linear-gradient(135deg, #059669, #047857);
      color: #fff;
      box-shadow: 0 4px 12px rgba(5, 150, 105, 0.3);
    }
    .toast {
      position: fixed;
      top: 60px;
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
  <header>
    <div class="brand">
      <span style="font-size: 16px;">📱</span>
      <strong style="font-size: 13px; color: #f1f5f9;">Chrome 远程操控</strong>
    </div>
    <div class="header-actions">
      <button class="btn-icon" id="btnToggleZoom">
        <span id="zoomIcon">🔍</span> <span id="zoomText">放大验证区</span>
      </button>
      <div id="statusBadge" class="status-badge">
        <span class="status-dot"></span>
        <span id="statusText">连接中...</span>
      </div>
    </div>
  </header>

  <div class="viewport-container" id="viewportContainer">
    <div class="quick-bar">
      <button class="quick-btn" id="btnQuickConnect">
        <span>🚀</span> 自动点击连接实例
      </button>
      <span style="color: #475569;">|</span>
      <span style="font-size: 11px; color: #94a3b8;" id="modeHint">双指或上方按钮可缩放</span>
    </div>
    <canvas id="screencast"></canvas>
    <div id="touchCursor" class="touch-cursor"></div>
  </div>

  <footer>
    <div class="footer-row">
      <button class="btn btn-secondary" id="btnRefresh">
        <span>🔄</span> 刷新验证码
      </button>
      <button class="btn btn-primary" id="btnCheck">
        <span>✅</span> 检查验证状态
      </button>
    </div>
  </footer>

  <div id="toast" class="toast"></div>

  <script>
    const canvas = document.getElementById('screencast');
    const ctx = canvas.getContext('2d');
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const touchCursor = document.getElementById('touchCursor');
    const btnToggleZoom = document.getElementById('btnToggleZoom');
    const zoomText = document.getElementById('zoomText');
    const zoomIcon = document.getElementById('zoomIcon');
    const btnQuickConnect = document.getElementById('btnQuickConnect');
    const btnRefresh = document.getElementById('btnRefresh');
    const btnCheck = document.getElementById('btnCheck');
    const toast = document.getElementById('toast');
    const modeHint = document.getElementById('modeHint');

    let ws = null;
    let fullWidth = 1280;
    let fullHeight = 800;
    let isTouching = false;
    let touchStartTime = 0;
    let startX = 0;
    let startY = 0;
    let isZoomed = false; // Zoom mode (crops to center modal)

    let frameImage = new Image();

    function renderFrame() {
      if (!frameImage.complete || frameImage.naturalWidth === 0) return;

      fullWidth = frameImage.width;
      fullHeight = frameImage.height;

      if (!isZoomed) {
        // Fullscreen overview
        if (canvas.width !== fullWidth || canvas.height !== fullHeight) {
          canvas.width = fullWidth;
          canvas.height = fullHeight;
        }
        ctx.drawImage(frameImage, 0, 0, fullWidth, fullHeight);
      } else {
        // Zoomed mode: Crop center region (width ~480px, height ~380px centered)
        const cropW = Math.min(fullWidth * 0.45, 520);
        const cropH = Math.min(fullHeight * 0.55, 420);
        const cropX = (fullWidth - cropW) / 2;
        const cropY = (fullHeight - cropH) / 2;

        if (canvas.width !== Math.round(cropW) || canvas.height !== Math.round(cropH)) {
          canvas.width = Math.round(cropW);
          canvas.height = Math.round(cropH);
        }
        ctx.drawImage(frameImage, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
      }
    }

    frameImage.onload = renderFrame;

    function showToast(msg, duration = 2000) {
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), duration);
    }

    function toggleZoom(forceState) {
      isZoomed = forceState !== undefined ? forceState : !isZoomed;
      if (isZoomed) {
        btnToggleZoom.classList.add('active');
        zoomIcon.textContent = '↔️';
        zoomText.textContent = '全景视图';
        modeHint.textContent = '已放大居中验证区 (超大滑块)';
        showToast('已放大居中验证区域，滑块更易拖动！');
      } else {
        btnToggleZoom.classList.remove('active');
        zoomIcon.textContent = '🔍';
        zoomText.textContent = '放大验证区';
        modeHint.textContent = '全景模式 (可点击按钮)';
        showToast('已切回全局全景模式');
      }
      renderFrame();
    }

    btnToggleZoom.addEventListener('click', () => toggleZoom());

    btnQuickConnect.addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'click_connect' }));
        showToast('正在自动连接实例并唤起验证码...');
        setTimeout(() => toggleZoom(true), 2000);
      }
    });

    function connectWebSocket() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + location.host + '/stream';

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        statusBadge.classList.remove('offline');
        statusText.textContent = '实时 30FPS';
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'frame') {
            frameImage.src = 'data:image/jpeg;base64,' + msg.data;
          } else if (msg.type === 'toast') {
            showToast(msg.message);
          } else if (msg.type === 'status') {
            showToast(msg.message, 3500);
          }
        } catch (e) {}
      };

      ws.onclose = () => {
        statusBadge.classList.add('offline');
        statusText.textContent = '已断开 (重连中)';
        setTimeout(connectWebSocket, 2000);
      };

      ws.onerror = () => {
        statusBadge.classList.add('offline');
        statusText.textContent = '连接异常';
      };
    }

    // Precise Coordinate mapping from canvas touch to actual Chrome page pixel coordinates
    function getPageCoords(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const relY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

      if (!isZoomed) {
        return {
          x: Math.round(relX * fullWidth),
          y: Math.round(relY * fullHeight),
        };
      } else {
        const cropW = Math.min(fullWidth * 0.45, 520);
        const cropH = Math.min(fullHeight * 0.55, 420);
        const cropX = (fullWidth - cropW) / 2;
        const cropY = (fullHeight - cropH) / 2;
        return {
          x: Math.round(cropX + relX * cropW),
          y: Math.round(cropY + relY * cropH),
        };
      }
    }

    function sendInput(event, clientX, clientY, buttons = 1) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const coords = getPageCoords(clientX, clientY);
      ws.send(JSON.stringify({
        type: 'input',
        event: event,
        x: coords.x,
        y: coords.y,
        buttons: buttons,
      }));
    }

    // Touch Event Handlers
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      isTouching = true;
      touchStartTime = Date.now();
      startX = touch.clientX;
      startY = touch.clientY;

      touchCursor.style.display = 'block';
      touchCursor.style.left = touch.clientX + 'px';
      touchCursor.style.top = touch.clientY + 'px';

      sendInput('mousedown', touch.clientX, touch.clientY, 1);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (!isTouching) return;
      e.preventDefault();
      const touch = e.touches[0];
      touchCursor.style.left = touch.clientX + 'px';
      touchCursor.style.top = touch.clientY + 'px';
      sendInput('mousemove', touch.clientX, touch.clientY, 1);
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      if (!isTouching) return;
      e.preventDefault();
      isTouching = false;
      touchCursor.style.display = 'none';
      const touch = e.changedTouches[0];
      const duration = Date.now() - touchStartTime;
      const dist = Math.hypot(touch.clientX - startX, touch.clientY - startY);

      if (duration < 250 && dist < 8) {
        // Quick tap: send explicit single click
        sendInput('click', touch.clientX, touch.clientY, 1);
      } else {
        sendInput('mouseup', touch.clientX, touch.clientY, 0);
      }
    }, { passive: false });

    window.addEventListener('touchcancel', () => {
      if (isTouching) {
        isTouching = false;
        touchCursor.style.display = 'none';
        sendInput('mouseup', 0, 0, 0);
      }
    });

    // Mouse Event Handlers for Desktop Testing
    canvas.addEventListener('mousedown', (e) => {
      isTouching = true;
      touchStartTime = Date.now();
      startX = e.clientX;
      startY = e.clientY;
      sendInput('mousedown', e.clientX, e.clientY, 1);
    });

    window.addEventListener('mousemove', (e) => {
      if (!isTouching) return;
      sendInput('mousemove', e.clientX, e.clientY, 1);
    });

    window.addEventListener('mouseup', (e) => {
      if (!isTouching) return;
      isTouching = false;
      const duration = Date.now() - touchStartTime;
      const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (duration < 250 && dist < 8) {
        sendInput('click', e.clientX, e.clientY, 1);
      } else {
        sendInput('mouseup', e.clientX, e.clientY, 0);
      }
    });

    btnRefresh.addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'refresh' }));
        showToast('正在请求刷新验证码...');
      }
    });

    btnCheck.addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'check' }));
      }
    });

    connectWebSocket();
  </script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

export default H5Server;
