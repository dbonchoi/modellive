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

      let restarted = false;
      let statusDesc = 'OK';
      let captchaBuffer = null;

      if (action === 'refresh') {
        logger.cdp(`[${notebookConfig.name}] Reloading page...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
        statusDesc = 'Page reloaded';
      } else if (action === 'interact') {
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
   * Smart check: Detects if notebook is running, stopped, or disconnected, and performs necessary recovery.
   * @param {import('playwright-core').Page} page
   * @param {object} notebookConfig
   * @param {object} [scheduleConfig={}]
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
      const modalRes = await this.handleSelectInstanceModal(page, notebookConfig);
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
          const modalRes = await this.handleSelectInstanceModal(page, notebookConfig);
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
   * @returns {Promise<{ success: boolean, captchaBuffer?: Buffer }>}
   */
  static async handleSelectInstanceModal(page, notebookConfig) {
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
          logger.warn(`[${notebookConfig.name}] Security captcha popup appeared after clicking connect!`);
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

      logger.info('Capturing security verification captcha modal screenshot...');
      const buffer = await captchaModal.screenshot({ type: 'png' }).catch(async () => {
        return await page.screenshot({ fullPage: false, type: 'png' });
      });

      return { visible: true, buffer };
    } catch (err) {
      logger.warn(`Error checking captcha modal: ${err.message}`);
      return { visible: false, buffer: null };
    }
  }

  /**
   * Execute human-like slider drag on the captcha modal.
   * @param {import('playwright-core').Page} page
   * @param {number} targetPercent (0 - 100)
   * @returns {Promise<{ success: boolean, message: string, newCaptchaBuffer?: Buffer }>}
   */
  static async executeSlideDrag(page, targetPercent = 50) {
    try {
      logger.info(`Simulating human slider drag to ${targetPercent}%...`);

      // Find drag button / slider handle
      const btnSelectors = [
        'div:has-text(">>")',
        'span:has-text(">>")',
        '[class*="btn_slide"]',
        '[class*="slider-button"]',
        '[class*="drag-btn"]',
        '[class*="nc_iconfont"]',
        '.nc_scale span',
        'div[class*="handler"]',
      ];

      let sliderBtn = null;
      for (const sel of btnSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            sliderBtn = el;
            break;
          }
        } catch {
          // continue
        }
      }

      if (!sliderBtn) {
        return { success: false, message: '未能找到滑块拖动按钮 (>>)' };
      }

      const btnBox = await sliderBtn.boundingBox();
      if (!btnBox) {
        return { success: false, message: '无法获取滑块坐标' };
      }

      // Find track to calculate total drag distance
      const trackSelectors = [
        '[class*="slide_track"]',
        '[class*="scale_text"]',
        '[class*="slider-track"]',
        'div:has-text("拖动滑块")',
        '.nc_scale',
      ];

      let trackWidth = 260; // standard default
      for (const sel of trackSelectors) {
        try {
          const t = await page.$(sel);
          if (t && (await t.isVisible())) {
            const tBox = await t.boundingBox();
            if (tBox && tBox.width > btnBox.width) {
              trackWidth = tBox.width - btnBox.width;
              break;
            }
          }
        } catch {
          // continue
        }
      }

      const dragDistance = Math.round(trackWidth * (Math.max(0, Math.min(100, targetPercent)) / 100));
      const startX = btnBox.x + btnBox.width / 2;
      const startY = btnBox.y + btnBox.height / 2;
      const targetX = startX + dragDistance;

      logger.info(`Slider drag start: (${startX}, ${startY}) -> target: (${targetX}, ${startY}), distance: ${dragDistance}px`);

      // Human-like smooth drag simulation
      await page.mouse.move(startX, startY);
      await this.sleep(100);
      await page.mouse.down();
      await this.sleep(80);

      const steps = 30;
      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        // Ease-out cubic curve + random small Y jitter
        const ease = 1 - Math.pow(1 - progress, 3);
        const curX = startX + dragDistance * ease;
        const jitterY = startY + (Math.random() * 4 - 2);
        await page.mouse.move(curX, jitterY);
        await this.sleep(15 + Math.floor(Math.random() * 10));
      }

      await this.sleep(120);
      await page.mouse.up();
      logger.success(`Slider drag completed. Waiting for verification result...`);
      await this.sleep(2500);

      // Check if captcha is still visible or disappeared
      const recheck = await this.checkAndCaptureCaptcha(page);
      if (!recheck.visible) {
        logger.success('Captcha verification passed successfully!');
        return { success: true, message: '🎉 滑块验证通过！实例正在继续连接运行...' };
      } else {
        logger.warn('Captcha still visible after drag; verification may have failed or needs another position.');
        return {
          success: false,
          message: '滑块验证未通过或角度不符，请参考新图片调整百分比重试。',
          newCaptchaBuffer: recheck.buffer,
        };
      }
    } catch (err) {
      logger.error(`Error during slider drag: ${err.message}`);
      return { success: false, message: `滑动执行异常: ${err.message}` };
    }
  }

  /**
   * Refresh captcha image on the verification modal
   * @param {import('playwright-core').Page} page
   */
  static async refreshCaptcha(page) {
    try {
      const refreshSelectors = [
        'div[class*="refresh"]',
        'span[class*="refresh"]',
        'svg[class*="refresh"]',
        'a[class*="refresh"]',
        '.nc_iconfont_refresh',
      ];
      for (const sel of refreshSelectors) {
        const el = await page.$(sel);
        if (el && (await el.isVisible())) {
          await el.click();
          await this.sleep(1500);
          return await this.checkAndCaptureCaptcha(page);
        }
      }
      return await this.checkAndCaptureCaptcha(page);
    } catch {
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
}

export default PageActions;
