import http from 'http';
import os from 'os';
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
 * Embedded H5 Web Server for Real-Time Interactive Captcha Slider.
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
    this.currentCaptchaBuffer = null;
    this.lastPercent = 50;
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
   * Start the HTTP server.
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
          if (url.pathname === '/captcha' || url.pathname === '/') {
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

      this.server.listen(this.port, '0.0.0.0', () => {
        const h5Url = this.getUrl();
        logger.success(`[H5Server] Interactive Captcha Web Server listening on ${h5Url}`);
        resolve(true);
      });

      this.server.on('error', (err) => {
        logger.warn(`[H5Server] Server error on port ${this.port}: ${err.message}`);
        resolve(false);
      });
    });
  }

  /**
   * Stop the HTTP server.
   */
  async stop() {
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

      if (cap.visible && cap.buffer) {
        this.currentCaptchaBuffer = cap.buffer;
        base64 = cap.buffer.toString('base64');
        active = true;
      } else if (this.currentCaptchaBuffer) {
        base64 = this.currentCaptchaBuffer.toString('base64');
        active = true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
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
   * Handle slide execution submitted from H5.
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
          // Notify Feishu
          if (this.notifier) {
            this.notifier.sendText(
              '🎉 ModelScope 实例已在手机 H5 端完成验证并成功连接运行！',
              this.notifier.config?.feishu?.adminUserIds?.[0]
            ).catch(() => {});
          }
          // Resume scheduler
          if (this.scheduler) {
            this.scheduler.runRound().catch(() => {});
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: '🎉 验证通过！ModelScope 实例连接成功！',
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
            message: '验证未通过，请在手机上微调滑动角度后再次点击提交。',
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
      if (cap.buffer) {
        this.currentCaptchaBuffer = cap.buffer;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          imageBase64: cap.buffer.toString('base64'),
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
   * Serve the responsive mobile-first H5 application.
   */
  handleServeH5(req, res) {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>ModelScope 安全验证交互面板</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      background-color: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 16px;
    }
    .header {
      width: 100%;
      max-width: 420px;
      text-align: center;
      margin-bottom: 16px;
      padding-top: 8px;
    }
    .header h1 {
      font-size: 20px;
      font-weight: 700;
      color: #38bdf8;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .header p {
      font-size: 13px;
      color: #94a3b8;
      margin-top: 4px;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 20px;
      padding: 20px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .preview-container {
      position: relative;
      width: 260px;
      height: 260px;
      border-radius: 50%;
      overflow: hidden;
      background: #090d16;
      border: 4px solid #38bdf8;
      box-shadow: 0 0 20px rgba(56, 189, 248, 0.35);
      margin: 12px 0 20px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
    }
    #preview-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform-origin: center center;
      transition: transform 0.04s linear;
      pointer-events: none;
    }
    /* Crosshair alignment guides */
    .guide-v, .guide-h {
      position: absolute;
      background: rgba(255, 255, 255, 0.25);
      pointer-events: none;
    }
    .guide-v { width: 1px; height: 100%; left: 50%; top: 0; }
    .guide-h { height: 1px; width: 100%; top: 50%; left: 0; }
    .guide-circle {
      position: absolute;
      width: 80%;
      height: 80%;
      border: 1px dashed rgba(56, 189, 248, 0.4);
      border-radius: 50%;
      pointer-events: none;
    }
    .live-stats {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 10px 16px;
      margin-bottom: 16px;
      font-size: 14px;
    }
    .stat-label { color: #94a3b8; }
    .stat-value { font-weight: 700; color: #38bdf8; font-family: monospace; font-size: 16px; }

    .slider-wrap {
      width: 100%;
      margin-bottom: 20px;
    }
    input[type=range] {
      -webkit-appearance: none;
      width: 100%;
      height: 12px;
      border-radius: 6px;
      background: #334155;
      outline: none;
    }
    input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #38bdf8;
      cursor: pointer;
      box-shadow: 0 0 10px #38bdf8;
      border: 3px solid #ffffff;
    }
    .fine-tune-row {
      width: 100%;
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .btn-tune {
      flex: 1;
      padding: 10px;
      background: #334155;
      color: #e2e8f0;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-tune:active { background: #475569; transform: scale(0.97); }

    .btn-submit {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #0284c7, #2563eb);
      color: #ffffff;
      border: none;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(37, 99, 235, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s;
    }
    .btn-submit:active { transform: scale(0.98); opacity: 0.9; }
    .btn-submit:disabled { background: #475569; cursor: not-allowed; box-shadow: none; }

    .btn-refresh {
      margin-top: 12px;
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 13px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px;
    }
    .btn-refresh:active { color: #f8fafc; }

    #status-msg {
      margin-top: 14px;
      font-size: 14px;
      text-align: center;
      min-height: 24px;
    }
    .msg-success { color: #4ade80; font-weight: 600; }
    .msg-error { color: #f87171; font-weight: 600; }
    .msg-info { color: #38bdf8; }

    .loading-spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: #ffffff;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>

  <div class="header">
    <h1>📱 实时滑动验证面板</h1>
    <p>拖动下方滑块，观察图片实时回正对齐</p>
  </div>

  <div class="card">
    <div class="preview-container">
      <img id="preview-img" src="" alt="Captcha Image">
      <div class="guide-v"></div>
      <div class="guide-h"></div>
      <div class="guide-circle"></div>
    </div>

    <div class="live-stats">
      <div>
        <span class="stat-label">滑动比例: </span>
        <span id="percent-val" class="stat-value">50.0%</span>
      </div>
      <div>
        <span class="stat-label">旋转角度: </span>
        <span id="angle-val" class="stat-value">180.0°</span>
      </div>
    </div>

    <div class="slider-wrap">
      <input type="range" id="slider" min="0" max="100" step="0.5" value="50">
    </div>

    <div class="fine-tune-row">
      <button class="btn-tune" onclick="adjustSlider(-5)">-5%</button>
      <button class="btn-tune" onclick="adjustSlider(-1)">-1%</button>
      <button class="btn-tune" onclick="adjustSlider(1)">+1%</button>
      <button class="btn-tune" onclick="adjustSlider(5)">+5%</button>
    </div>

    <button id="submit-btn" class="btn-submit" onclick="submitSlide()">
      <span>🚀 确认提交滑动 (50.0%)</span>
    </button>

    <div id="status-msg"></div>

    <button class="btn-refresh" onclick="refreshCaptcha()">🔄 刷新换一张验证码</button>
  </div>

  <script>
    const slider = document.getElementById('slider');
    const previewImg = document.getElementById('preview-img');
    const percentVal = document.getElementById('percent-val');
    const angleVal = document.getElementById('angle-val');
    const submitBtn = document.getElementById('submit-btn');
    const statusMsg = document.getElementById('status-msg');

    let currentPercent = 50;

    function updateView(percent) {
      currentPercent = Math.max(0, Math.min(100, Number(percent)));
      const angle = (currentPercent * 3.6).toFixed(1);
      
      // Real-time CSS Rotation
      previewImg.style.transform = \`rotate(\${angle}deg)\`;
      
      percentVal.innerText = currentPercent.toFixed(1) + '%';
      angleVal.innerText = angle + '°';
      submitBtn.querySelector('span').innerText = \`🚀 确认提交滑动 (\${currentPercent.toFixed(1)}%)\`;
    }

    slider.addEventListener('input', (e) => {
      updateView(e.target.value);
    });

    function adjustSlider(delta) {
      const newPercent = Math.max(0, Math.min(100, currentPercent + delta));
      slider.value = newPercent;
      updateView(newPercent);
    }

    async function loadState() {
      statusMsg.innerHTML = '<span class="msg-info">正在获取验证码状态...</span>';
      try {
        const res = await fetch('/api/captcha-state');
        const data = await res.json();
        if (data.active && data.imageBase64) {
          previewImg.src = 'data:image/png;base64,' + data.imageBase64;
          slider.value = data.lastPercent || 50;
          updateView(slider.value);
          statusMsg.innerHTML = '';
        } else {
          statusMsg.innerHTML = '<span class="msg-info">当前未检测到活跃验证码，请在飞书发送 /start</span>';
        }
      } catch (err) {
        statusMsg.innerHTML = '<span class="msg-error">加载失败: ' + err.message + '</span>';
      }
    }

    async function submitSlide() {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<div class="loading-spinner"></div> 正在同步滑动...';
      statusMsg.innerHTML = '<span class="msg-info">正在电脑端模拟真人手势滑动...</span>';

      try {
        const res = await fetch('/api/submit-slide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ percent: currentPercent })
        });
        const result = await res.json();

        if (result.success) {
          statusMsg.innerHTML = '<span class="msg-success">' + result.message + '</span>';
          submitBtn.innerHTML = '<span>🎉 验证已通过！</span>';
          submitBtn.style.background = '#22c55e';
        } else {
          statusMsg.innerHTML = '<span class="msg-error">' + result.message + '</span>';
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>🚀 再次提交滑动</span>';
          if (result.newImageBase64) {
            previewImg.src = 'data:image/png;base64,' + result.newImageBase64;
          }
        }
      } catch (err) {
        statusMsg.innerHTML = '<span class="msg-error">提交出错: ' + err.message + '</span>';
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>🚀 重试提交</span>';
      }
    }

    async function refreshCaptcha() {
      statusMsg.innerHTML = '<span class="msg-info">正在刷新验证码...</span>';
      try {
        const res = await fetch('/api/refresh-captcha', { method: 'POST' });
        const data = await res.json();
        if (data.success && data.imageBase64) {
          previewImg.src = 'data:image/png;base64,' + data.imageBase64;
          slider.value = 50;
          updateView(50);
          statusMsg.innerHTML = '<span class="msg-success">已刷新验证码图片</span>';
        } else {
          statusMsg.innerHTML = '<span class="msg-error">' + (data.message || '刷新失败') + '</span>';
        }
      } catch (err) {
        statusMsg.innerHTML = '<span class="msg-error">刷新失败: ' + err.message + '</span>';
      }
    }

    // Auto-load on page ready
    loadState();
  </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

export default H5Server;
