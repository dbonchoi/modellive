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
 * Embedded H5 Web Server for Real-Time Interactive Captcha Slider (Mobile Viewport Optimized).
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
            message: '验证未通过，请在手机上微调滑动位置后再次点击提交。',
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>ModelScope 安全验证</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html, body {
      width: 100%;
      height: 100%;
      height: 100dvh;
      overflow: hidden;
      background-color: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      padding: 8px 12px;
    }
    .header {
      width: 100%;
      max-width: 400px;
      text-align: center;
      margin-bottom: 6px;
    }
    .header h1 {
      font-size: 16px;
      font-weight: 700;
      color: #38bdf8;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .header p {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 1px;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 10px 12px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    /* Mode Tabs */
    .tabs {
      width: 100%;
      display: flex;
      background: #0f172a;
      border-radius: 10px;
      padding: 2px;
      margin-bottom: 8px;
      gap: 4px;
    }
    .tab-btn {
      flex: 1;
      padding: 6px 4px;
      border: none;
      background: transparent;
      color: #94a3b8;
      font-size: 12px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .tab-btn.active {
      background: #38bdf8;
      color: #0f172a;
      font-weight: 700;
    }

    /* Jigsaw Mode */
    .jigsaw-container {
      position: relative;
      width: 100%;
      background: #090d16;
      border: 2px solid #38bdf8;
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
      touch-action: none;
    }
    #jigsaw-img {
      width: 100%;
      height: auto;
      max-height: 40vh;
      object-fit: contain;
      display: block;
      pointer-events: none;
    }
    .target-cursor {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 3px;
      background: #38bdf8;
      box-shadow: 0 0 10px #38bdf8, 0 0 16px #0284c7;
      left: 50%;
      transform: translateX(-50%);
      pointer-events: none;
      z-index: 10;
    }
    .target-box {
      position: absolute;
      top: 35%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 38px;
      height: 38px;
      border: 2px dashed #facc15;
      background: rgba(56, 189, 248, 0.2);
      border-radius: 6px;
      pointer-events: none;
      box-shadow: 0 0 8px rgba(250, 204, 21, 0.4);
      z-index: 11;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: #facc15;
      font-weight: bold;
    }

    /* Rotation Mode */
    .rotation-container {
      position: relative;
      width: 170px;
      height: 170px;
      border-radius: 50%;
      overflow: hidden;
      background: #090d16;
      border: 3px solid #38bdf8;
      box-shadow: 0 0 16px rgba(56, 189, 248, 0.3);
      margin: 2px 0 8px 0;
      display: none;
      align-items: center;
      justify-content: center;
      user-select: none;
    }
    #rotation-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform-origin: center center;
      pointer-events: none;
    }
    .guide-v, .guide-h {
      position: absolute;
      background: rgba(255, 255, 255, 0.25);
      pointer-events: none;
    }
    .guide-v { width: 1px; height: 100%; left: 50%; top: 0; }
    .guide-h { height: 1px; width: 100%; top: 50%; left: 0; }

    .live-stats {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 6px 12px;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .stat-label { color: #94a3b8; }
    .stat-value { font-weight: 700; color: #38bdf8; font-family: monospace; font-size: 15px; }

    .slider-wrap {
      width: 100%;
      margin-bottom: 10px;
      padding: 0 4px;
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
      gap: 6px;
      margin-bottom: 10px;
    }
    .btn-tune {
      flex: 1;
      padding: 8px 4px;
      background: #334155;
      color: #e2e8f0;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-tune:active { background: #475569; transform: scale(0.97); }

    .btn-submit {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #0284c7, #2563eb);
      color: #ffffff;
      border: none;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .btn-submit:active { transform: scale(0.98); opacity: 0.9; }
    .btn-submit:disabled { background: #475569; cursor: not-allowed; box-shadow: none; }

    .btn-refresh {
      margin-top: 6px;
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
    }

    #status-msg {
      margin-top: 4px;
      font-size: 12px;
      text-align: center;
      min-height: 18px;
    }
    .msg-success { color: #4ade80; font-weight: 600; }
    .msg-error { color: #f87171; font-weight: 600; }
    .msg-info { color: #38bdf8; }

    .loading-spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
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
    <h1>📱 手机滑动验证面板</h1>
    <p>拖动滑块使标靶对准缺口或回正</p>
  </div>

  <div class="card">
    <div class="tabs">
      <button id="tab-jigsaw" class="tab-btn active" onclick="switchMode('jigsaw')">🧩 拼图从左到右平移</button>
      <button id="tab-rotation" class="tab-btn" onclick="switchMode('rotation')">🔄 旋转回正模式</button>
    </div>

    <!-- Jigsaw Mode -->
    <div id="jigsaw-view" class="jigsaw-container">
      <img id="jigsaw-img" src="" alt="Captcha Image">
      <div id="target-cursor" class="target-cursor"></div>
      <div id="target-box" class="target-box">对齐处</div>
    </div>

    <!-- Rotation Mode -->
    <div id="rotation-view" class="rotation-container">
      <img id="rotation-img" src="" alt="Captcha Rotation Image">
      <div class="guide-v"></div>
      <div class="guide-h"></div>
    </div>

    <div class="live-stats">
      <div>
        <span class="stat-label">滑动比例: </span>
        <span id="percent-val" class="stat-value">50.0%</span>
      </div>
      <div>
        <span id="mode-stat-label" class="stat-label">横向位置: </span>
        <span id="mode-stat-val" class="stat-value">50%</span>
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
    const jigsawView = document.getElementById('jigsaw-view');
    const rotationView = document.getElementById('rotation-view');
    const jigsawImg = document.getElementById('jigsaw-img');
    const rotationImg = document.getElementById('rotation-img');
    const targetCursor = document.getElementById('target-cursor');
    const targetBox = document.getElementById('target-box');
    const percentVal = document.getElementById('percent-val');
    const modeStatLabel = document.getElementById('mode-stat-label');
    const modeStatVal = document.getElementById('mode-stat-val');
    const submitBtn = document.getElementById('submit-btn');
    const statusMsg = document.getElementById('status-msg');

    let currentMode = 'jigsaw';
    let currentPercent = 50;

    function switchMode(mode) {
      currentMode = mode;
      document.getElementById('tab-jigsaw').classList.toggle('active', mode === 'jigsaw');
      document.getElementById('tab-rotation').classList.toggle('active', mode === 'rotation');
      
      if (mode === 'jigsaw') {
        jigsawView.style.display = 'flex';
        rotationView.style.display = 'none';
        modeStatLabel.innerText = '横向位置: ';
      } else {
        jigsawView.style.display = 'none';
        rotationView.style.display = 'flex';
        modeStatLabel.innerText = '旋转角度: ';
      }
      updateView(currentPercent);
    }

    function updateView(percent) {
      currentPercent = Math.max(0, Math.min(100, Number(percent)));
      percentVal.innerText = currentPercent.toFixed(1) + '%';
      submitBtn.querySelector('span').innerText = \`🚀 确认提交滑动 (\${currentPercent.toFixed(1)}%)\`;

      if (currentMode === 'jigsaw') {
        targetCursor.style.left = currentPercent + '%';
        targetBox.style.left = currentPercent + '%';
        modeStatVal.innerText = currentPercent.toFixed(1) + '%';
      } else {
        const angle = (currentPercent * 3.6).toFixed(1);
        rotationImg.style.transform = \`rotate(\${angle}deg)\`;
        modeStatVal.innerText = angle + '°';
      }
    }

    slider.addEventListener('input', (e) => {
      updateView(e.target.value);
    });

    // Touch directly on jigsaw image to jump to position
    jigsawView.addEventListener('pointerdown', (e) => {
      const rect = jigsawView.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(100, (clickX / rect.width) * 100));
      slider.value = pct;
      updateView(pct);
    });

    function adjustSlider(delta) {
      const newPercent = Math.max(0, Math.min(100, currentPercent + delta));
      slider.value = newPercent;
      updateView(newPercent);
    }

    async function loadState() {
      statusMsg.innerHTML = '<span class="msg-info">正在获取验证码...</span>';
      try {
        const res = await fetch('/api/captcha-state');
        const data = await res.json();
        if (data.active && data.imageBase64) {
          const imgSrc = 'data:image/png;base64,' + data.imageBase64;
          jigsawImg.src = imgSrc;
          rotationImg.src = imgSrc;
          slider.value = data.lastPercent || 50;
          updateView(slider.value);
          statusMsg.innerHTML = '';
        } else {
          statusMsg.innerHTML = '<span class="msg-info">未检测到验证码，请在飞书发送 /start</span>';
        }
      } catch (err) {
        statusMsg.innerHTML = '<span class="msg-error">加载失败: ' + err.message + '</span>';
      }
    }

    async function submitSlide() {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<div class="loading-spinner"></div> 正在电脑端模拟真人滑动...';
      statusMsg.innerHTML = '<span class="msg-info">正在同步滑动 (' + currentPercent.toFixed(1) + '%)...</span>';

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
            const newSrc = 'data:image/png;base64,' + result.newImageBase64;
            jigsawImg.src = newSrc;
            rotationImg.src = newSrc;
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
          const newSrc = 'data:image/png;base64,' + data.imageBase64;
          jigsawImg.src = newSrc;
          rotationImg.src = newSrc;
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
