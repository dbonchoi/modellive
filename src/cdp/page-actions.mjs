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

      // 3. Find the "查看实例" dropdown item (poll for up to 3.5s)
      const viewInstanceSelectors = [
        'div:has-text("查看实例")',
        'span:has-text("查看实例")',
        'li:has-text("查看实例")',
        'a:has-text("查看实例")',
        '.ant-dropdown-menu-item:has-text("查看实例")',
        '.ant-dropdown :has-text("查看实例")',
        '.ant-popover :has-text("查看实例")',
        '[class*="menu"]:has-text("查看实例")',
        '[class*="dropdown"]:has-text("查看实例")',
      ];

      let viewItem = null;
      const startWait = Date.now();
      while (Date.now() - startWait < 3500) {
        for (const sel of viewInstanceSelectors) {
          try {
            const els = await page.$$(sel);
            for (const el of els) {
              if (await el.isVisible()) {
                viewItem = el;
                break;
              }
            }
            if (viewItem) break;
          } catch {}
        }
        if (viewItem) break;
        // If not appeared, re-hover
        if (box) {
          await page.mouse.move(centerX, centerY);
        }
        await this.sleep(400);
      }

      if (!viewItem) {
        logger.warn('Could not find 【查看实例】 in dropdown menu.');
        return {
          success: false,
          needsLogin: false,
          targetUrl: page.url(),
          buffer: null,
          message: '未能唤出或找到【查看实例】菜单项，请检查电脑端页面是否处于前台。',
        };
      }

      // 4. Hover & Click "查看实例" and listen for newly opened tab
      logger.info('Found 【查看实例】 menu item, clicking to open PAI-DSW tab...');
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
        logger.warn('Alibaba Cloud login is required to access instance detail.');
        return {
          success: true,
          needsLogin: true,
          targetUrl,
          buffer,
          message: '已弹出阿里云登录页面，请使用【RAM 账号】或手机扫码完成登录。',
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
}

export default PageActions;
