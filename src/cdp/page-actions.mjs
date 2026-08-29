import logger from '../logger.mjs';

/**
 * Executes keepalive actions on a specific ModelScope Notebook page.
 */
export class PageActions {
  /**
   * Helper to wait with a non-blocking timeout.
   * @param {number} ms
   */
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Main keepalive runner for a given page.
   * @param {import('playwright-core').Page} page
   * @param {object} notebookConfig
   * @param {object} scheduleConfig
   * @returns {Promise<{ success: boolean, action: string, status: string, durationMs: number, restarted?: boolean, captchaBuffer?: Buffer, error?: string }>}
   */
  static async execute(page, notebookConfig, scheduleConfig = {}) {
    const startedAt = Date.now();
    const action = notebookConfig.action || 'smart';
    const timeoutMs = (notebookConfig.timeoutSeconds || scheduleConfig.timeoutSeconds || 60) * 1000;
    const holdMs = (notebookConfig.holdSeconds || scheduleConfig.holdSeconds || 15) * 1000;

    logger.cdp(`[${notebookConfig.name || notebookConfig.id}] Starting keepalive action="${action}" on ${notebookConfig.url}`);

    try {
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(timeoutMs);

      // Check current URL vs target URL
      const currentUrl = page.url();
      if (!currentUrl || currentUrl === 'about:blank' || !currentUrl.includes('modelscope.cn')) {
        logger.cdp(`[${notebookConfig.name}] Navigating to ${notebookConfig.url}`);
        await page.goto(notebookConfig.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      }

      // Check instance running status
      const running = await this.isInstanceRunning(page);
      if (running) {
        logger.success(`[${notebookConfig.name}] 🎉 Instance is active in cloud. Auto-assumed keepalive protection.`);
        await this.simulateUserActivity(page).catch(() => {});
        return {
          success: true,
          action,
          status: 'Running',
          durationMs: Date.now() - startedAt,
          restarted: false,
          isRunning: true,
        };
      }

      let restarted = false;
      let statusDesc = 'Running';
      let captchaBuffer = null;

      if (action === 'refresh') {
        logger.cdp(`[${notebookConfig.name}] Refreshing page...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
        statusDesc = 'Page reloaded';
      } else if (action === 'click_terminal') {
        logger.cdp(`[${notebookConfig.name}] Focusing terminal...`);
        await this.focusTerminal(page);
        statusDesc = 'Terminal focused';
      } else if (action === 'simulate_user') {
        logger.cdp(`[${notebookConfig.name}] Simulating user interaction...`);
        await this.simulateUserActivity(page);
        statusDesc = 'Activity simulated';
      } else {
        // smart mode
        logger.cdp(`[${notebookConfig.name}] Running smart keepalive checks... (forceStart=${Boolean(scheduleConfig.forceStart)})`);
        const checkResult = await this.smartCheckAndAct(page, notebookConfig, scheduleConfig);
        restarted = checkResult.restarted;
        statusDesc = checkResult.statusDesc;
        captchaBuffer = checkResult.captchaBuffer || null;
      }

      // Hold time: only hold for normal active keepalive rounds, not during manual commands or disconnected waits
      const isTransientState = captchaBuffer || scheduleConfig.forceStart || statusDesc.includes('Disconnected') || statusDesc.includes('Ready');
      if (holdMs > 0 && !isTransientState) {
        logger.cdp(`[${notebookConfig.name}] Holding page for ${(holdMs / 1000).toFixed(1)}s`);
        await this.sleep(holdMs);
      }

      const durationMs = Date.now() - startedAt;
      logger.success(`[${notebookConfig.name}] Keepalive completed (${(durationMs / 1000).toFixed(1)}s) - ${statusDesc}`);

      return {
        success: !captchaBuffer,
        action,
        status: statusDesc,
        durationMs,
        restarted,
        captchaBuffer,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      logger.error(`[${notebookConfig.name}] Keepalive failed (${(durationMs / 1000).toFixed(1)}s): ${err.message}`);
      return {
        success: false,
        action,
        status: 'Error',
        durationMs,
        error: err.message,
      };
    }
  }

  /**
   * Smart check: checks notebook kernel status, terminal, or reconnect buttons.
   * @param {import('playwright-core').Page} page
   * @param {object} notebookConfig
   * @param {object} [scheduleConfig={}]
   * @returns {Promise<{ restarted: boolean, statusDesc: string, captchaBuffer?: Buffer }>}
   */
  static async smartCheckAndAct(page, notebookConfig, scheduleConfig = {}) {
    let restarted = false;
    let statusDesc = 'Running';
    const allowLaunch = notebookConfig.autoStart === true || scheduleConfig.forceStart === true;

    // 1. Check if captcha modal is already open
    const existingCaptcha = await this.checkAndCaptureCaptcha(page);
    if (existingCaptcha.buffer) {
      logger.warn(`[${notebookConfig.name}] Security verification / captcha modal is currently open.`);
      return { restarted: false, statusDesc: 'Captcha Verification Required', captchaBuffer: existingCaptcha.buffer };
    }

    // 2. Check if "选择实例" modal (Ant Design Modal) is ALREADY OPEN on screen
    const isModalOpen = await this.isSelectInstanceModalOpen(page);
    if (isModalOpen) {
      if (!allowLaunch) {
        logger.info(`[${notebookConfig.name}] '选择实例' modal is open, but autoStart is false. Waiting for /start command.`);
        return { restarted: false, statusDesc: 'Ready to connect (Send /start in Feishu)' };
      }

      logger.info(`[${notebookConfig.name}] '选择实例' modal dialog is open. Proceeding to select & connect...`);
      const modalRes = await this.handleSelectInstanceModal(page, notebookConfig, scheduleConfig);
      restarted = true;
      if (modalRes.captchaBuffer) {
        return { restarted: true, statusDesc: 'Captcha Verification Required', captchaBuffer: modalRes.captchaBuffer };
      }
      statusDesc = modalRes.success ? 'Runtime instance connected' : 'Connecting instance...';
      return { restarted, statusDesc };
    }

    // 3. Look for ModelScope Code Editor "连接运行时" button
    const connectRuntimeSelectors = [
      'button:has-text("连接运行时")',
      'div[role="button"]:has-text("连接运行时")',
      'a:has-text("连接运行时")',
      '[class*="connect"]:has-text("连接运行时")',
    ];

    for (const sel of connectRuntimeSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && (await btn.isVisible())) {
          if (!allowLaunch) {
            logger.info(`[${notebookConfig.name}] Found '连接运行时' button, but autoStart is false. Waiting for /start command.`);
            return { restarted: false, statusDesc: 'Disconnected (Send /start in Feishu)' };
          }

          logger.warn(`[${notebookConfig.name}] Detected '连接运行时' button in Code Editor. Clicking to launch instance...`);
          await page.evaluate(el => el.click(), btn).catch(async () => {
            await btn.click({ force: true, timeout: 3000 });
          });
          await this.sleep(2000);

          // Handle the "选择实例" (Select Instance) popup modal
          const modalRes = await this.handleSelectInstanceModal(page, notebookConfig, scheduleConfig);
          restarted = true;

          if (modalRes.captchaBuffer) {
            return { restarted: true, statusDesc: 'Captcha Verification Required', captchaBuffer: modalRes.captchaBuffer };
          }

          statusDesc = modalRes.success ? 'Runtime instance connected' : 'Connecting instance...';
          return { restarted, statusDesc };
        }
      } catch (err) {
        logger.warn(`Error handling connect runtime button: ${err.message}`);
      }
    }

    // 4. Look for reconnect / wake / resume buttons
    const resumeBtnSelectors = [
      'button:has-text("重新连接")',
      'button:has-text("恢复运行")',
      'button:has-text("继续使用")',
      'button:has-text("Reconnect")',
      'button:has-text("Resume")',
    ];

    for (const sel of resumeBtnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && (await btn.isVisible())) {
          logger.warn(`[${notebookConfig.name}] Detected disconnected prompt. Clicking reconnect button: ${sel}`);
          await page.evaluate(el => el.click(), btn).catch(async () => {
            await btn.click({ force: true, timeout: 5000 });
          });
          restarted = true;
          statusDesc = 'Reconnected after sleep';
          await this.sleep(3000);
          return { restarted, statusDesc };
        }
      } catch {
        // ignore
      }
    }

    // 5. If on workspace list page, check if specific instance is stopped
    if (allowLaunch) {
      const startBtnSelectors = [
        'button:has-text("启动")',
        'button:has-text("开启")',
        'button:has-text("Start")',
      ];

      for (const sel of startBtnSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && (await btn.isVisible())) {
            logger.warn(`[${notebookConfig.name}] Found stopped instance start button. Clicking start...`);
            await page.evaluate(el => el.click(), btn).catch(async () => {
              await btn.click({ force: true, timeout: 5000 });
            });
            restarted = true;
            statusDesc = 'Auto-started stopped instance';
            await this.sleep(3000);
            return { restarted, statusDesc };
          }
        } catch {
          // ignore
        }
      }
    }

    // 6. If running normally inside Code Editor / JupyterLab / DSW workspace, simulate mouse/keyboard activity
    await this.simulateUserActivity(page);
    statusDesc = 'Active & Heartbeat simulated';

    return { restarted, statusDesc };
  }

  /**
   * Check if "选择实例" modal is currently open on screen
   * @param {import('playwright-core').Page} page
   */
  static async isSelectInstanceModalOpen(page) {
    try {
      const modalSelectors = [
        'div:has-text("选择实例")',
        '.antd5-modal-title:has-text("选择实例")',
        'div[role="dialog"]:has-text("选择实例")',
        '.antd5-modal-content:has-text("选择实例")',
      ];
      for (const sel of modalSelectors) {
        const el = await page.$(sel);
        if (el && (await el.isVisible())) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Handle "选择实例" modal dialog in Code Editor
   * @param {import('playwright-core').Page} page
   * @param {object} notebookConfig
   * @param {object} [scheduleConfig={}]
   * @returns {Promise<{ success: boolean, captchaBuffer?: Buffer }>}
   */
  static async handleSelectInstanceModal(page, notebookConfig, scheduleConfig = {}) {
    try {
      logger.info(`[${notebookConfig.name}] Handling '选择实例' modal...`);

      const modal = await page.$('.antd5-modal-content, .ant-modal-content, div[role="dialog"]');
      if (!modal) {
        logger.warn(`[${notebookConfig.name}] Modal container element not found.`);
        return { success: false };
      }

      // Check instance type preference (e.g., 'GPU', 'AMD GPU', 'CPU')
      const targetType = (notebookConfig.instanceType || 'CPU').toUpperCase();
      const allTabs = await modal.$$('.antd5-segmented-item, .ant-segmented-item, div, span, button');
      for (const tab of allTabs) {
        try {
          const text = (await tab.innerText()).trim();
          if (targetType.includes('GPU') && !targetType.includes('AMD') && text.includes('GPU 类型')) {
            logger.info(`[${notebookConfig.name}] Selecting GPU instance tab...`);
            await tab.click({ force: true }).catch(() => {});
            await this.sleep(500);
            break;
          } else if (targetType.includes('AMD') && text.includes('AMD GPU')) {
            logger.info(`[${notebookConfig.name}] Selecting AMD GPU instance tab...`);
            await tab.click({ force: true }).catch(() => {});
            await this.sleep(500);
            break;
          } else if (targetType.includes('CPU') && text.includes('CPU 类型')) {
            logger.info(`[${notebookConfig.name}] Selecting CPU instance tab...`);
            await tab.click({ force: true }).catch(() => {});
            await this.sleep(500);
            break;
          }
        } catch {
          // continue
        }
      }

      // Find the EXACT "连接" button inside the modal
      let confirmBtn = null;
      const buttons = await modal.$$('button');
      for (const b of buttons) {
        try {
          const btnText = (await b.innerText()).trim();
          // STRICT exact text match for "连接"
          if (btnText === '连接') {
            confirmBtn = b;
            break;
          }
        } catch {
          // continue
        }
      }

      if (!confirmBtn) {
        confirmBtn = await modal.$('button.antd5-btn-primary, button.ant-btn-primary');
      }

      if (confirmBtn) {
        logger.info(`[${notebookConfig.name}] Clicking modal confirmation button '连接'...`);
        await confirmBtn.click({ force: true, timeout: 5000 });
        await this.sleep(2500);

        // Check if captcha appeared
        const cap = await this.checkAndCaptureCaptcha(page);
        if (cap.buffer) {
          logger.warn(`[${notebookConfig.name}] Security captcha popup appeared after clicking connect! Ready for H5 / Feishu slide.`);
          return { success: false, captchaBuffer: cap.buffer };
        }

        return { success: true };
      } else {
        logger.warn(`[${notebookConfig.name}] Could not locate exact '连接' button inside modal.`);
      }

      return { success: false };
    } catch (err) {
      logger.warn(`Error handling select instance modal: ${err.message}`);
      return { success: false };
    }
  }

  /**
   * Check if security verification / slider captcha is visible and capture its screenshot.
   * @param {import('playwright-core').Page} page
   * @returns {Promise<{ visible: boolean, buffer: Buffer | null }>}
   */
  static async checkAndCaptureCaptcha(page) {
    try {
      const captchaSelectors = [
        'div:has-text("请完成安全验证")',
        'div:has-text("拖动滑块")',
        '.nc-container',
        'div[class*="captcha"]',
        'div[class*="verify-modal"]',
        'div[role="dialog"]:has-text("安全验证")',
      ];

      let captchaModal = null;
      for (const sel of captchaSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            captchaModal = el;
            break;
          }
        } catch {
          // continue
        }
      }

      if (!captchaModal) {
        return { visible: false, buffer: null };
      }

      // Prefer the inner captcha container to eliminate surrounding modal whitespace
      let targetElement = captchaModal;
      const innerSelectors = [
        '.nc-container',
        '.nc_scale',
        'div[class*="captcha"]',
        'div[class*="nc_"]',
        'div[class*="verify"]',
      ];
      for (const sel of innerSelectors) {
        try {
          const inner = await captchaModal.$(sel);
          if (inner && (await inner.isVisible())) {
            const b = await inner.boundingBox();
            if (b && b.width >= 200 && b.height >= 140) {
              targetElement = inner;
              break;
            }
          }
        } catch {}
      }

      logger.info('Capturing security verification captcha modal screenshot...');
      const rawBuffer = await targetElement.screenshot({ type: 'png' }).catch(async () => {
        return await page.screenshot({ fullPage: false, type: 'png' });
      });

      // Get exact slider metrics to calibrate visual ruler precisely
      const { sliderBtn, sliderTrack } = await this.findSliderElements(page);
      let trackWidth = 260;
      let btnWidth = 40;
      let startOffset = 0;

      if (sliderBtn) {
        const btnBox = await sliderBtn.boundingBox();
        if (btnBox) btnWidth = btnBox.width;
      }
      if (sliderTrack) {
        const trackBox = await sliderTrack.boundingBox();
        if (trackBox && trackBox.width > btnWidth) {
          trackWidth = trackBox.width - btnWidth;
        }
      }

      let buffer = rawBuffer;
      if (buffer) {
        buffer = await this.addVisualRuler(page, buffer, { trackWidth, btnWidth, startOffset });
      }

      return { visible: true, buffer, rawBuffer };
    } catch (err) {
      logger.warn(`Error checking captcha modal: ${err.message}`);
      return { visible: false, buffer: null, rawBuffer: null };
    }
  }

  /**
   * Draw vertical guide grid lines and calibrated percentage ruler bar onto captcha image.
   * Uses isolated evaluation context to prevent any DOM or focus disturbance in the active page.
   * @param {import('playwright-core').Page} page
   * @param {Buffer} imageBuffer
   * @param {object} [metrics={}]
   * @returns {Promise<Buffer>}
   */
  static async addVisualRuler(page, imageBuffer, metrics = {}) {
    try {
      const base64 = imageBuffer.toString('base64');
      const trackWidth = metrics.trackWidth || 260;
      const btnWidth = metrics.btnWidth || 40;
      const startOffset = metrics.startOffset || 0;

      // Find an isolated page in the context (like about:blank) to avoid running evaluate on the live dragging page
      const context = page.context ? page.context() : null;
      let evalPage = page;
      if (context) {
        const pages = context.pages();
        const blankPage = pages.find(p => p.url() === 'about:blank');
        if (blankPage && !blankPage.isClosed()) {
          evalPage = blankPage;
        }
      }

      const rulerBase64 = await evalPage.evaluate(async ({ b64, trackWidth, btnWidth, startOffset }) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height + 46;
            const ctx = canvas.getContext('2d');

            // 1. Draw base image
            ctx.drawImage(img, 0, 0);

            const totalW = img.width;
            const totalH = img.height;

            // Maximum draggable distance corresponding to 100%
            const effMaxX = Math.min(totalW, Math.max(80, trackWidth));

            // 2. Draw vertical reference dashed grid lines calibrated to the exact slider travel
            for (let p = 10; p <= 100; p += 10) {
              const x = startOffset + Math.round((effMaxX * p) / 100);
              if (x <= totalW) {
                const isMajor = p % 20 === 0 || p === 100;
                ctx.strokeStyle = (p === 100) ? 'rgba(0, 240, 255, 0.85)' : (isMajor ? 'rgba(0, 240, 255, 0.45)' : 'rgba(255, 230, 0, 0.35)');
                ctx.lineWidth = isMajor ? 2 : 1;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, totalH);
                ctx.stroke();
              }
            }
            ctx.setLineDash([]);

            // 3. Draw Ruler bottom bar
            ctx.fillStyle = '#111827';
            ctx.fillRect(0, totalH, totalW, 46);

            // Divider line
            ctx.strokeStyle = '#374151';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, totalH);
            ctx.lineTo(totalW, totalH);
            ctx.stroke();

            // 4. Draw ruler scale ticks and percentage text labels
            ctx.font = 'bold 11px "Segoe UI", Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            for (let p = 0; p <= 100; p += 10) {
              const x = startOffset + Math.round((effMaxX * p) / 100);
              if (x <= totalW) {
                const isMajor = p % 20 === 0 || p === 100;
                ctx.strokeStyle = isMajor ? '#38bdf8' : '#fbbf24';
                ctx.lineWidth = isMajor ? 2 : 1;
                ctx.beginPath();
                ctx.moveTo(x, totalH);
                ctx.lineTo(x, totalH + (isMajor ? 12 : 7));
                ctx.stroke();

                ctx.fillStyle = isMajor ? '#38bdf8' : '#fbbf24';
                const textX = (p === 0) ? x + 12 : ((x > totalW - 16) ? totalW - 16 : x);
                ctx.fillText(`${p}%`, textX, totalH + 26);
              }
            }

            // Mark unreachable piece-width zone at right edge if any
            if (effMaxX < totalW - 5) {
              ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
              ctx.fillRect(effMaxX, 0, totalW - effMaxX, totalH);
            }

            resolve(canvas.toDataURL('image/png').split(',')[1]);
          };
          img.onerror = () => resolve(b64);
          img.src = 'data:image/png;base64,' + b64;
        });
      }, { b64: base64, trackWidth, btnWidth, startOffset });

      if (rulerBase64) {
        return Buffer.from(rulerBase64, 'base64');
      }
      return imageBuffer;
    } catch (err) {
      logger.warn(`Visual ruler overlay minor error: ${err.message}`);
      return imageBuffer;
    }
  }

  /**
   * Locate the captcha slider button and track elements across main page and frames.
   * @param {import('playwright-core').Page} page
   */
  static async findSliderElements(page) {
    const frames = [page, ...page.frames()];

    const btnSelectors = [
      '#nc_1_n1z',
      '[id$="_n1z"]',
      'span.btn_slide',
      'div.btn_slide',
      '.nc_iconfont.btn_slide',
      '.nc_scale span',
      '[class*="btn_slide"]',
      '[class*="slider-button"]',
      '[class*="drag-btn"]',
      '[class*="slider-btn"]',
      '[class*="handler"]',
      '[class*="drag"]',
      'div[role="slider"]',
      'span[role="slider"]',
    ];

    const trackSelectors = [
      '#nc_1__scale_text',
      '.scale_text',
      '.nc_scale',
      '[class*="scale_text"]',
      '[class*="slide_track"]',
      '[class*="slider-track"]',
      'div:has-text("拖动滑块")',
      'span:has-text("拖动滑块")',
    ];

    for (const frame of frames) {
      try {
        let sliderBtn = null;
        let sliderTrack = null;

        for (const sel of btnSelectors) {
          try {
            const els = await frame.$$(sel);
            for (const el of els) {
              if (await el.isVisible()) {
                const box = await el.boundingBox();
                if (box && box.width >= 15 && box.height >= 15) {
                  sliderBtn = el;
                  break;
                }
              }
            }
            if (sliderBtn) break;
          } catch {}
        }

        for (const sel of trackSelectors) {
          try {
            const el = await frame.$(sel);
            if (el && (await el.isVisible())) {
              const box = await el.boundingBox();
              if (box && box.width >= 50) {
                sliderTrack = el;
                break;
              }
            }
          } catch {}
        }

        // Fallback: If not found by CSS, evaluate DOM structure inside verification modal
        if (!sliderBtn) {
          const btnHandle = await frame.evaluateHandle(() => {
            const track = document.querySelector('.scale_text, .nc_scale, [class*="slider"], [class*="track"]') ||
                          Array.from(document.querySelectorAll('div, span')).find(el => el.innerText && el.innerText.includes('拖动滑块'));
            if (track) {
              const parent = track.parentElement || track;
              const potentialBtns = parent.querySelectorAll('span, div');
              for (const b of potentialBtns) {
                const rect = b.getBoundingClientRect();
                if (rect.width >= 20 && rect.width <= 90 && rect.height >= 20 && rect.height <= 90) {
                  return b;
                }
              }
            }
            return null;
          }).catch(() => null);

          if (btnHandle) {
            const btn = btnHandle.asElement();
            if (btn && (await btn.isVisible())) {
              sliderBtn = btn;
            }
          }
        }

        if (sliderBtn) {
          return { frame, sliderBtn, sliderTrack };
        }
      } catch {}
    }

    return { frame: null, sliderBtn: null, sliderTrack: null };
  }

  static dragSession = {
    active: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentPercent: 0,
    trackWidth: 260,
  };

  /**
   * Drag slider to target percentage and HOLD (do not mouse.up).
   * Returns screenshot of the held position for user visual confirmation.
   * @param {import('playwright-core').Page} page
   * @param {number} targetPercent (0 - 100)
   * @returns {Promise<{ success: boolean, holding: boolean, percent: number, buffer?: Buffer, message?: string }>}
   */
  static async dragAndHold(page, targetPercent = 50) {
    try {
      logger.info(`[Captcha Drag] Dragging to ${targetPercent.toFixed(1)}% and HOLDING for user confirmation...`);

      if (!this.dragSession.active) {
        const { sliderBtn, sliderTrack } = await this.findSliderElements(page);
        if (!sliderBtn) {
          logger.warn('Could not locate slider drag handle (#nc_1_n1z / .btn_slide).');
          return { success: false, holding: false, percent: targetPercent, message: '未能定位到滑块按钮，请在电脑端操作。' };
        }

        const btnBox = await sliderBtn.boundingBox();
        if (!btnBox) {
          return { success: false, holding: false, percent: targetPercent, message: '无法获取滑块按钮坐标。' };
        }

        let trackWidth = 260;
        if (sliderTrack) {
          const trackBox = await sliderTrack.boundingBox();
          if (trackBox && trackBox.width > btnBox.width) {
            trackWidth = trackBox.width - btnBox.width;
          }
        }

        const startX = btnBox.x + btnBox.width / 2;
        const startY = btnBox.y + btnBox.height / 2;

        await page.mouse.move(startX, startY);
        await this.sleep(80);
        await page.mouse.down();
        await this.sleep(100);

        this.dragSession = {
          active: true,
          startX,
          startY,
          currentX: startX,
          currentPercent: 0,
          trackWidth,
        };
      }

      // Calculate target X from track width and percentage
      const ratio = Math.max(0, Math.min(100, targetPercent)) / 100;
      const targetX = this.dragSession.startX + Math.round(this.dragSession.trackWidth * ratio);
      const fromX = this.dragSession.currentX;
      const distance = targetX - fromX;

      const steps = Math.max(12, Math.min(35, Math.round(Math.abs(distance) / 6)));
      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const ease = 1 - Math.pow(1 - progress, 3);
        const currX = fromX + distance * ease;
        const jitterY = this.dragSession.startY + (Math.sin(progress * Math.PI) * (Math.random() * 2 - 1));
        await page.mouse.move(currX, jitterY);
        await this.sleep(10 + Math.floor(Math.random() * 8));
      }

      await page.mouse.move(targetX, this.dragSession.startY);
      await this.sleep(200);

      this.dragSession.currentX = targetX;
      this.dragSession.currentPercent = targetPercent;

      logger.info(`[Captcha Drag] Held at ${targetPercent.toFixed(1)}% (${targetX.toFixed(1)}px). Capturing held screenshot...`);

      const cap = await this.checkAndCaptureCaptcha(page);
      return {
        success: true,
        holding: true,
        percent: targetPercent,
        buffer: cap.buffer || cap.rawBuffer,
      };
    } catch (err) {
      logger.error(`Error in dragAndHold: ${err.message}`);
      return { success: false, holding: false, percent: targetPercent, message: err.message };
    }
  }

  /**
   * Release the currently held slider button to commit verification.
   * @param {import('playwright-core').Page} page
   * @returns {Promise<{ success: boolean, message: string, newCaptchaBuffer?: Buffer }>}
   */
  static async releaseSlider(page) {
    try {
      logger.info('[Captcha Drag] User confirmed release! Releasing slider in Chrome (mouse.up)...');
      await page.mouse.up().catch(() => {});
      this.dragSession.active = false;

      logger.success('Slider released. Waiting for verification result...');
      await this.sleep(2500);

      const recheck = await this.checkAndCaptureCaptcha(page);
      if (!recheck.visible) {
        logger.success('Captcha verification passed successfully!');
        return {
          success: true,
          message: '🎉 滑块验证通过！实例正在继续连接运行...',
        };
      } else {
        logger.warn('Captcha still visible after release; verification failed or position needs adjustment.');
        return {
          success: false,
          message: '滑块验证未通过，请重新调整百分比。',
          newCaptchaBuffer: recheck.buffer,
        };
      }
    } catch (err) {
      logger.error(`Error in releaseSlider: ${err.message}`);
      this.dragSession.active = false;
      return { success: false, message: `释放滑块异常: ${err.message}` };
    }
  }

  /**
   * Cancel active drag and reset/refresh captcha.
   * @param {import('playwright-core').Page} page
   */
  static async cancelDrag(page) {
    try {
      if (this.dragSession.active) {
        await page.mouse.up().catch(() => {});
        this.dragSession.active = false;
      }
      return await this.refreshCaptcha(page);
    } catch (err) {
      this.dragSession.active = false;
      return { buffer: null };
    }
  }

  /**
   * Execute one-shot human-like slider drag and release (compatibility helper).
   * @param {import('playwright-core').Page} page
   * @param {number} targetPercent (0 - 100)
   * @returns {Promise<{ success: boolean, message: string, postDragBuffer?: Buffer, newCaptchaBuffer?: Buffer }>}
   */
  static async executeSlideDrag(page, targetPercent = 50) {
    const holdRes = await this.dragAndHold(page, targetPercent);
    const postDragBuffer = holdRes.buffer || null;
    const releaseRes = await this.releaseSlider(page);
    return {
      success: releaseRes.success,
      message: releaseRes.message,
      postDragBuffer,
      newCaptchaBuffer: releaseRes.newCaptchaBuffer,
    };
  }

  /**
   * Check if a ModelScope notebook instance is already active / running.
   * @param {import('playwright-core').Page} page
   * @returns {Promise<boolean>}
   */
  static async isInstanceRunning(page) {
    try {
      // 1. If connect button is visible, instance is NOT running
      const connectBtn = await page.$('button:has-text("连接运行时"), div[role="button"]:has-text("连接运行时"), a:has-text("连接运行时")');
      if (connectBtn && (await connectBtn.isVisible())) {
        return false;
      }

      // 2. If instance select modal or captcha modal is open, instance is NOT running
      const isModal = await this.isSelectInstanceModalOpen(page);
      if (isModal) {
        return false;
      }
      const cap = await this.checkAndCaptureCaptcha(page);
      if (cap.visible) {
        return false;
      }

      // 3. If disconnected or reconnect prompts are visible, instance is NOT running
      const resumeBtn = await page.$('button:has-text("重新连接"), button:has-text("恢复运行"), button:has-text("继续使用"), button:has-text("启动")');
      if (resumeBtn && (await resumeBtn.isVisible())) {
        return false;
      }

      // 4. Check if page contains active workspace indicators
      const activeSelectors = [
        'div:has-text("CPU")',
        'div:has-text("GPU")',
        'span:has-text("CPU")',
        'span:has-text("GPU")',
        'div[class*="editor"]',
        'div[class*="workspace"]',
        'div[class*="terminal"]',
      ];

      for (const sel of activeSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            return true;
          }
        } catch {}
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Refresh captcha image on the verification modal
   * @param {import('playwright-core').Page} page
   */
  static async refreshCaptcha(page) {
    try {
      logger.info('Attempting to refresh captcha image in browser...');
      const frames = [page, ...page.frames()];

      const refreshSelectors = [
        '#nc_1_refresh1',
        'a.btn_refresh',
        '.btn_refresh',
        'a.nc_iconfont.btn_refresh',
        '.nc_iconfont_refresh',
        '[class*="btn_refresh"]',
        '[class*="refresh"]',
        'a[class*="refresh"]',
        'span[class*="refresh"]',
        'div[class*="refresh"]',
        'svg[class*="refresh"]',
      ];

      for (const frame of frames) {
        for (const sel of refreshSelectors) {
          try {
            const els = await frame.$$(sel);
            for (const el of els) {
              if (await el.isVisible()) {
                const box = await el.boundingBox();
                if (box && box.width > 5 && box.height > 5) {
                  logger.info(`Clicking refresh button: ${sel} at (${box.x.toFixed(1)}, ${box.y.toFixed(1)})`);
                  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                  await this.sleep(400);
                  await frame.evaluate(e => {
                    e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  }, el).catch(() => {});
                  await this.sleep(1500);
                  return await this.checkAndCaptureCaptcha(page);
                }
              }
            }
          } catch {}
        }
      }

      // If specific selector not found, find captcha image modal and click top-right icon area
      const modal = await page.$('.nc-container, .nc_scale, .antd5-modal-content, div[role="dialog"]');
      if (modal) {
        const box = await modal.boundingBox();
        if (box) {
          const clickX = box.x + box.width - 24;
          const clickY = box.y + 24;
          logger.info(`Clicking top-right refresh area: (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);
          await page.mouse.click(clickX, clickY);
          await this.sleep(1500);
          return await this.checkAndCaptureCaptcha(page);
        }
      }

      return await this.checkAndCaptureCaptcha(page);
    } catch (err) {
      logger.warn(`Refresh captcha error: ${err.message}`);
      return { visible: false, buffer: null };
    }
  }

  /**
   * Simulate user activity (mouse move, wheel scroll, keyboard event, or window focus)
   * @param {import('playwright-core').Page} page
   */
  static async simulateUserActivity(page) {
    try {
      await page.bringToFront().catch(() => {});
      // Small mouse move
      await page.mouse.move(100 + Math.floor(Math.random() * 200), 100 + Math.floor(Math.random() * 200));
      await page.mouse.wheel(0, 10);
      await this.sleep(200);
      await page.mouse.wheel(0, -10);

      // Execute a lightweight ping in the page context to prevent browser tab from throttling
      await page.evaluate(() => {
        window.dispatchEvent(new Event('mousemove'));
        window.dispatchEvent(new Event('keydown'));
        window._modellive_last_heartbeat = Date.now();
      }).catch(() => {});
    } catch (err) {
      logger.warn(`User activity simulation minor error: ${err.message}`);
    }
  }

  /**
   * Click '实例运行中' dropdown and '查看实例' to open Alibaba Cloud PAI-DSW notebook console tab.
   * If Alibaba Cloud login is required, captures login screen; if already active, captures DSW console.
   * @param {import('playwright-core').Page} page
   * @returns {Promise<{ success: boolean, needsLogin: boolean, targetUrl: string, buffer: Buffer | null, message: string }>}
   */
  static async openInstanceDetail(page) {
    try {
      logger.info('Opening Alibaba Cloud instance details via ModelScope top bar...');

      // 1. Find the "实例运行中" status button
      const statusBtnSelectors = [
        'button:has-text("实例运行中")',
        'div:has-text("实例运行中")',
        'span:has-text("实例运行中")',
        '[class*="status"]:has-text("实例运行中")',
        '[class*="running"]:has-text("实例运行中")',
      ];

      let statusBtn = null;
      for (const sel of statusBtnSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            statusBtn = el;
            break;
          }
        } catch {}
      }

      if (!statusBtn) {
        return {
          success: false,
          needsLogin: false,
          targetUrl: page.url(),
          buffer: null,
          message: '未在页面顶部找到【实例运行中】按钮，请确认工作空间实例处于运行状态。',
        };
      }

      const box = await statusBtn.boundingBox();
      const centerX = box ? (box.x + box.width / 2) : 0;
      const centerY = box ? (box.y + box.height / 2) : 0;

      // 2. Hover mouse over "实例运行中" and click to trigger Ant Design Dropdown/Popover
      logger.info(`Hovering and clicking 【实例运行中】 button at (${centerX.toFixed(1)}, ${centerY.toFixed(1)})...`);
      if (box) {
        await page.mouse.move(centerX, centerY);
        await this.sleep(200);
      }
      await statusBtn.hover().catch(() => {});
      await page.evaluate((el) => {
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      }, statusBtn).catch(() => {});
      await this.sleep(300);

      // Also click the button in case it uses click trigger
      await statusBtn.click({ timeout: 2000 }).catch(() => {});
      await this.sleep(800);

      // 3. Find the exact "查看实例" dropdown item (the 1st item in dropdown menu)
      let viewItemHandle = null;
      const startWait = Date.now();
      while (Date.now() - startWait < 4000) {
        viewItemHandle = await page.evaluateHandle(() => {
          // Look for all dropdown menu items across Antd components
          const allItems = Array.from(document.querySelectorAll('.ant-dropdown-menu-item, li[role="menuitem"], .ant-dropdown li, .ant-popover div[class*="item"], div[class*="menu-item"], div[class*="action-item"]'));
          
          for (const item of allItems) {
            const txt = (item.innerText || item.textContent || '').trim();
            // Strictly require "查看实例" and exclude "停止" / "关闭"
            if (txt.includes('查看实例') && !txt.includes('停止') && !txt.includes('关闭')) {
              return item;
            }
          }

          // Fallback: If in visible dropdown menu, pick the 1st child item if not "停止"
          const visibleMenu = document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden) ul, .ant-dropdown:not([style*="display: none"]) ul, .ant-popover:not(.ant-popover-hidden)');
          if (visibleMenu) {
            const firstChild = visibleMenu.querySelector('li:first-child, .ant-dropdown-menu-item:first-child, div:first-child');
            if (firstChild) {
              const txt = (firstChild.innerText || firstChild.textContent || '').trim();
              if (!txt.includes('停止') && !txt.includes('关闭')) {
                return firstChild;
              }
            }
          }
          return null;
        }).catch(() => null);

        if (viewItemHandle) {
          const el = viewItemHandle.asElement();
          if (el && (await el.isVisible())) {
            break;
          }
        }

        // Re-hover if not yet visible
        if (box) {
          await page.mouse.move(centerX, centerY);
        }
        await this.sleep(400);
      }

      const viewItem = viewItemHandle ? viewItemHandle.asElement() : null;

      if (!viewItem) {
        logger.warn('Could not locate 【查看实例】 item in dropdown menu.');
        return {
          success: false,
          needsLogin: false,
          targetUrl: page.url(),
          buffer: null,
          message: '未能定位到下拉菜单中的【查看实例】按钮。',
        };
      }

      // Safety check text
      const targetText = await viewItem.innerText().catch(() => '');
      if (targetText.includes('停止') || targetText.includes('关闭')) {
        logger.error(`CRITICAL: Selected element contains dangerous text ("${targetText}"). Aborting click.`);
        return {
          success: false,
          needsLogin: false,
          targetUrl: page.url(),
          buffer: null,
          message: '安全拦截：检测到所选项目为停止实例，已自动终止操作防止关机。',
        };
      }

      // 4. Hover & Click "查看实例" (1st item) and listen for newly opened tab
      logger.info(`Found 1st menu item ("${targetText.trim() || '查看实例'}"), clicking to open PAI-DSW tab...`);
      const context = page.context();
      let targetPage = null;

      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
        viewItem.click({ force: true, timeout: 5000 }).catch(async () => {
          await page.evaluate(el => el.click(), viewItem);
        }),
      ]);

      if (popup) {
        targetPage = popup;
      } else {
        await this.sleep(2500);
        const pages = context.pages();
        targetPage = pages.find(p => p.url().includes('aliyun.com') || p.url().includes('dsw') || p.url().includes('pai'));
        if (!targetPage && pages.length > 1) {
          targetPage = pages[pages.length - 1];
        }
      }

      if (!targetPage) {
        targetPage = page;
      }

      await targetPage.waitForLoadState('domcontentloaded').catch(() => {});
      await this.sleep(2500);

      const targetUrl = targetPage.url();
      logger.info(`Instance detail page loaded: ${targetUrl}`);

      // Check if Alibaba Cloud login page
      const isAliyunLogin = targetUrl.includes('signin.aliyun.com') || targetUrl.includes('login.htm') || targetUrl.includes('account.aliyun.com') || targetUrl.includes('login.taobao.com');

      let buffer = null;
      try {
        buffer = await targetPage.screenshot({ fullPage: false, type: 'png' });
      } catch (e) {
        logger.warn(`Failed to capture instance detail screenshot: ${e.message}`);
      }

      if (isAliyunLogin) {
        logger.info('Alibaba Cloud login page detected. Automatically clicking 【RAM登录】...');
        const ramRes = await this.switchToRamLogin(targetPage);
        return {
          success: true,
          needsLogin: true,
          isRamForm: ramRes.isRamForm,
          targetUrl,
          buffer: ramRes.buffer || buffer,
          message: '已自动切换至【阿里云 RAM 子账号登录】页面！\n\n' +
                   '👉 请在飞书发送子账号与密码进行登录：\n' +
                   '• 快捷方式：`/ram <子账号> <密码>`\n' +
                   '• 或分步方式：`/ram user <子账号>` ➔ `/ram pass <密码>`\n' +
                   '• 若有验证码：`/ram code <验证码>`',
        };
      }

      logger.success('Alibaba Cloud instance detail (PAI-DSW) opened successfully!');
      return {
        success: true,
        needsLogin: false,
        targetUrl,
        buffer,
        message: '🎉 已成功打开阿里云实例窗口 (PAI-DSW)！',
      };
    } catch (err) {
      logger.error(`Error opening instance detail: ${err.message}`);
      return {
        success: false,
        needsLogin: false,
        targetUrl: page.url(),
        buffer: null,
        message: `查看实例异常: ${err.message}`,
      };
    }
  }

  /**
   * Switch Alibaba Cloud login page to RAM (Sub-account) mode.
   * @param {import('playwright-core').Page} page
   * @returns {Promise<{ success: boolean, isRamForm: boolean, buffer: Buffer | null, message?: string }>}
   */
  static async switchToRamLogin(page) {
    try {
      logger.info('Checking/Switching to Alibaba Cloud RAM login form...');

      // 1. Check if "RAM登录" link/button exists on the page
      const ramSelectors = [
        'a:has-text("RAM登录")',
        'span:has-text("RAM登录")',
        'div:has-text("RAM登录")',
        'p:has-text("RAM登录")',
        'a[href*="ram"]',
        '[class*="ram"]',
        'a:has-text("RAM")',
      ];

      let ramLink = null;
      for (const sel of ramSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            ramLink = el;
            break;
          }
        } catch {}
      }

      // If not found by CSS, evaluate DOM text
      if (!ramLink) {
        const handle = await page.evaluateHandle(() => {
          const els = Array.from(document.querySelectorAll('a, span, div, p, button'));
          return els.find(el => {
            const t = (el.innerText || el.textContent || '').trim();
            return t.includes('RAM') && t.includes('登录');
          }) || null;
        }).catch(() => null);
        if (handle) {
          const el = handle.asElement();
          if (el && (await el.isVisible().catch(() => false))) {
            ramLink = el;
          }
        }
      }

      if (ramLink) {
        logger.info('Found 【RAM登录 >】 link on login card. Clicking to switch to RAM login mode...');
        await ramLink.hover().catch(() => {});
        await page.evaluate(el => el.click(), ramLink).catch(async () => {
          await ramLink.click({ force: true, timeout: 3000 });
        });
        await this.sleep(3000);
      } else {
        logger.info('No 【RAM登录 >】 link visible, checking if already on RAM login form...');
      }

      // 2. Check if we are now on RAM sub-account form
      const isRam = await page.evaluate(() => {
        const hasUserPrincipal = !!document.querySelector('#user_principal_name, input[name="user_principal_name"], #username_ims');
        const text = document.body ? document.body.innerText : '';
        return hasUserPrincipal || text.includes('RAM 用户') || text.includes('企业别名') || text.includes('返回主账号登录');
      }).catch(() => false);

      const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
      return { success: true, isRamForm: isRam, buffer };
    } catch (err) {
      logger.warn(`Failed to switch to RAM login: ${err.message}`);
      const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
      return { success: false, isRamForm: false, buffer, message: err.message };
    }
  }

  /**
   * Step 1: Submit RAM sub-account username and click '下一步'.
   * @param {import('playwright-core').Page} page
   * @param {string} username
   * @returns {Promise<{ success: boolean, buffer: Buffer | null, hasPasswordPrompt: boolean, message: string }>}
   */
  static async submitRamUsername(page, username) {
    try {
      logger.info(`[RAM Login] Entering sub-account username: "${username}"...`);
      await this.switchToRamLogin(page);

      const userInputSelectors = [
        '#user_principal_name',
        'input[name="user_principal_name"]',
        'input[placeholder*="企业别名"]',
        'input[placeholder*="账号"]',
        'input[placeholder*="用户名"]',
        '#fm-login-id',
        'input[type="text"]',
      ];

      let inputEl = null;
      for (const sel of userInputSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            inputEl = el;
            break;
          }
        } catch {}
      }

      if (!inputEl) {
        const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
        return { success: false, buffer, hasPasswordPrompt: false, message: '未能找到 RAM 子账号输入框，请确认处于 RAM 登录页。' };
      }

      // Focus and fill username
      await inputEl.click({ timeout: 2000 });
      await inputEl.fill('');
      await inputEl.type(username.trim(), { delay: 60 });
      await this.sleep(400);

      // Find "下一步" button
      const nextBtnSelectors = [
        'button:has-text("下一步")',
        'input[value="下一步"]',
        'button[type="submit"]',
        '#btn-submit',
        'div:has-text("下一步")',
      ];

      for (const sel of nextBtnSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && (await btn.isVisible())) {
            logger.info(`Clicking RAM next button (${sel})...`);
            await btn.click({ timeout: 3000 });
            break;
          }
        } catch {}
      }

      await this.sleep(2500);

      const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
      const passwordInput = await page.$('#password_ims, input[name="password_ims"], input[type="password"]').catch(() => null);
      const hasPasswordPrompt = !!passwordInput && (await passwordInput.isVisible().catch(() => false));

      return {
        success: true,
        buffer,
        hasPasswordPrompt,
        message: hasPasswordPrompt
          ? `✅ 子账号【${username}】已输入成功！已进入密码输入步骤。\n👉 请发送：\`/ram pass <密码>\``
          : `子账号已提交，正在等待下一步响应。`,
      };
    } catch (err) {
      logger.error(`Error submitting RAM username: ${err.message}`);
      const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
      return { success: false, buffer, hasPasswordPrompt: false, message: `输入子账号异常: ${err.message}` };
    }
  }

  /**
   * Step 2: Submit RAM password and click '登录'.
   * @param {import('playwright-core').Page} page
   * @param {string} password
   * @returns {Promise<{ success: boolean, loggedIn: boolean, needsCode: boolean, needsSlider: boolean, buffer: Buffer | null, message: string }>}
   */
  static async submitRamPassword(page, password) {
    try {
      logger.info('[RAM Login] Entering sub-account password...');

      const passInputSelectors = [
        '#password_ims',
        'input[name="password_ims"]',
        'input[type="password"]',
        'input[placeholder*="密码"]',
        '#fm-login-password',
      ];

      let passEl = null;
      for (const sel of passInputSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            passEl = el;
            break;
          }
        } catch {}
      }

      if (!passEl) {
        const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
        return {
          success: false,
          loggedIn: false,
          needsCode: false,
          needsSlider: false,
          buffer,
          message: '未能找到密码输入框，请先发送 `/ram user <子账号>` 或检查页面状态。',
        };
      }

      await passEl.click({ timeout: 2000 });
      await passEl.fill('');
      await passEl.type(password.trim(), { delay: 40 });
      await this.sleep(400);

      // Find "登录" button
      const loginBtnSelectors = [
        'button:has-text("登录")',
        'input[value="登录"]',
        'button[type="submit"]',
        '#btn-submit',
        'div:has-text("登录")',
      ];

      for (const sel of loginBtnSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && (await btn.isVisible())) {
            logger.info(`Clicking RAM submit login button (${sel})...`);
            await btn.click({ timeout: 3000 });
            break;
          }
        } catch {}
      }

      await this.sleep(3500);

      const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
      const url = page.url();

      // Check if logged in (redirected to DSW console or aliyun home)
      const isSuccess = url.includes('dsw') || url.includes('console.aliyun.com') || url.includes('pai') || (!url.includes('signin.aliyun.com') && !url.includes('login.htm'));

      // Check if SMS / MFA verification code is needed
      const codeInput = await page.$('input[placeholder*="验证码"], input[placeholder*="动态口令"], input[placeholder*="MFA"], input[name*="code"], input[name*="verify"]').catch(() => null);
      const needsCode = !!codeInput && (await codeInput.isVisible().catch(() => false));

      // Check if sliding captcha is present
      const cap = await this.checkAndCaptureCaptcha(page);
      const needsSlider = cap.visible;

      let message = '登录已提交。';
      if (isSuccess) {
        message = '🎉 阿里云 RAM 子账号登录成功！PAI-DSW 实例窗口已就绪，守护进程已持久化记住会话！';
      } else if (needsCode) {
        message = '🟡 检测到需要二次验证码（短信 / MFA 动态口令）！\n👉 请发送：\`/ram code <验证码>\`';
      } else if (needsSlider) {
        message = '🟡 检测到需要滑块安全验证！\n👉 请在飞书发送滑动比例（如 `/slide 45`）或在 H5 面板微调。';
      }

      return {
        success: true,
        loggedIn: isSuccess,
        needsCode,
        needsSlider,
        buffer: needsSlider ? (cap.buffer || buffer) : buffer,
        message,
      };
    } catch (err) {
      logger.error(`Error submitting RAM password: ${err.message}`);
      const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
      return {
        success: false,
        loggedIn: false,
        needsCode: false,
        needsSlider: false,
        buffer,
        message: `输入密码异常: ${err.message}`,
      };
    }
  }

  /**
   * Step 3: Submit RAM SMS / MFA verification code.
   * @param {import('playwright-core').Page} page
   * @param {string} code
   * @returns {Promise<{ success: boolean, loggedIn: boolean, buffer: Buffer | null, message: string }>}
   */
  static async submitRamVerifyCode(page, code) {
    try {
      logger.info(`[RAM Login] Entering verification code: "${code}"...`);

      const codeInputSelectors = [
        'input[placeholder*="验证码"]',
        'input[placeholder*="动态口令"]',
        'input[placeholder*="MFA"]',
        'input[name*="code"]',
        'input[name*="verify"]',
        'input[type="number"]',
        'input[type="text"]',
      ];

      let codeEl = null;
      for (const sel of codeInputSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            codeEl = el;
            break;
          }
        } catch {}
      }

      if (!codeEl) {
        const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
        return { success: false, loggedIn: false, buffer, message: '未能找到验证码输入框。' };
      }

      await codeEl.click({ timeout: 2000 });
      await codeEl.fill('');
      await codeEl.type(code.trim(), { delay: 60 });
      await this.sleep(400);

      // Find submit button
      const submitSelectors = [
        'button:has-text("确定")',
        'button:has-text("提交")',
        'button:has-text("验证")',
        'button:has-text("登录")',
        'button[type="submit"]',
        '#btn-submit',
      ];

      for (const sel of submitSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && (await btn.isVisible())) {
            await btn.click({ timeout: 3000 });
            break;
          }
        } catch {}
      }

      await this.sleep(3500);

      const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
      const url = page.url();
      const isSuccess = url.includes('dsw') || url.includes('console.aliyun.com') || url.includes('pai') || (!url.includes('signin.aliyun.com') && !url.includes('login.htm'));

      return {
        success: true,
        loggedIn: isSuccess,
        buffer,
        message: isSuccess
          ? '🎉 阿里云 RAM 登录成功！PAI-DSW 实例已完全就绪！'
          : '验证码已提交，正在等待登录响应。',
      };
    } catch (err) {
      logger.error(`Error submitting RAM verify code: ${err.message}`);
      const buffer = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);
      return { success: false, loggedIn: false, buffer, message: `输入验证码异常: ${err.message}` };
    }
  }

  /**
   * Execute one-shot full RAM sub-account login.
   * @param {import('playwright-core').Page} page
   * @param {string} username
   * @param {string} password
   * @param {string} [code]
   */
  static async executeFullRamLogin(page, username, password, code = '') {
    const userRes = await this.submitRamUsername(page, username);
    if (!userRes.success && !userRes.hasPasswordPrompt) {
      return userRes;
    }
    await this.sleep(1000);
    const passRes = await this.submitRamPassword(page, password);
    if (code && passRes.needsCode) {
      await this.sleep(1000);
      return await this.submitRamVerifyCode(page, code);
    }
    return passRes;
  }
}

export default PageActions;
