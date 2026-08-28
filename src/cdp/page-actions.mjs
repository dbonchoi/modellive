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
   * @returns {Promise<{ success: boolean, action: string, status: string, durationMs: number, restarted?: boolean, error?: string }>}
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
        logger.cdp(`[${notebookConfig.name}] Running smart keepalive checks...`);
        const checkResult = await this.smartCheckAndAct(page, notebookConfig);
        restarted = checkResult.restarted;
        statusDesc = checkResult.statusDesc;
      }

      // Hold time
      if (holdMs > 0) {
        logger.cdp(`[${notebookConfig.name}] Holding page for ${(holdMs / 1000).toFixed(1)}s`);
        await this.sleep(holdMs);
      }

      const durationMs = Date.now() - startedAt;
      logger.success(`[${notebookConfig.name}] Keepalive completed successfully (${(durationMs / 1000).toFixed(1)}s) - ${statusDesc}`);

      return {
        success: true,
        action,
        status: statusDesc,
        durationMs,
        restarted,
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
   */
  static async smartCheckAndAct(page, notebookConfig) {
    let restarted = false;
    let statusDesc = 'Running';

    // 1. Look for ModelScope Code Editor "连接运行时" button (as in user screenshot)
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
          logger.warn(`[${notebookConfig.name}] Detected '连接运行时' button in Code Editor. Clicking to launch instance...`);
          await btn.click({ timeout: 5000 });
          await this.sleep(1500);

          // Handle the "选择实例" (Select Instance) popup modal
          const modalHandled = await this.handleSelectInstanceModal(page, notebookConfig);
          restarted = true;
          statusDesc = modalHandled ? 'Runtime instance connected' : 'Clicked connect runtime';
          return { restarted, statusDesc };
        }
      } catch (err) {
        logger.warn(`Error handling connect runtime button: ${err.message}`);
      }
    }

    // 2. Look for reconnect / wake / resume buttons
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
          await btn.click({ timeout: 5000 });
          restarted = true;
          statusDesc = 'Reconnected after sleep';
          await this.sleep(3000);
          return { restarted, statusDesc };
        }
      } catch {
        // ignore
      }
    }

    // 3. If on workspace list page, check if specific instance is stopped
    if (notebookConfig.autoStart) {
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
            await btn.click({ timeout: 5000 });
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

    // 4. If running normally inside Code Editor / JupyterLab / DSW workspace, simulate mouse/keyboard activity
    await this.simulateUserActivity(page);
    statusDesc = 'Active & Heartbeat simulated';

    return { restarted, statusDesc };
  }

  /**
   * Handle "选择实例" modal dialog in Code Editor
   * @param {import('playwright-core').Page} page
   * @param {object} notebookConfig
   */
  static async handleSelectInstanceModal(page, notebookConfig) {
    try {
      const modalHeader = await page.$('div:has-text("选择实例"), h3:has-text("选择实例"), h4:has-text("选择实例")');
      if (!modalHeader) {
        // Check if modal container is present
        const connectBtn = await page.$('button:has-text("连接")');
        if (connectBtn && (await connectBtn.isVisible())) {
          logger.info(`[${notebookConfig.name}] Found modal '连接' button, clicking...`);
          await connectBtn.click({ timeout: 5000 });
          await this.sleep(3000);
          return true;
        }
        return false;
      }

      // Check instance type preference (e.g., 'GPU', 'AMD GPU', 'CPU')
      const targetType = (notebookConfig.instanceType || '').toUpperCase();
      if (targetType.includes('GPU') && !targetType.includes('AMD')) {
        const gpuTab = await page.$('div:has-text("GPU 类型"), button:has-text("GPU 类型"), span:has-text("GPU 类型")');
        if (gpuTab && (await gpuTab.isVisible())) {
          logger.info(`[${notebookConfig.name}] Selecting GPU instance tab...`);
          await gpuTab.click().catch(() => {});
          await this.sleep(500);
        }
      } else if (targetType.includes('AMD')) {
        const amdTab = await page.$('div:has-text("AMD GPU类型"), button:has-text("AMD GPU类型"), span:has-text("AMD GPU类型")');
        if (amdTab && (await amdTab.isVisible())) {
          logger.info(`[${notebookConfig.name}] Selecting AMD GPU instance tab...`);
          await amdTab.click().catch(() => {});
          await this.sleep(500);
        }
      } else if (targetType.includes('CPU')) {
        const cpuTab = await page.$('div:has-text("CPU 类型"), button:has-text("CPU 类型"), span:has-text("CPU 类型")');
        if (cpuTab && (await cpuTab.isVisible())) {
          logger.info(`[${notebookConfig.name}] Selecting CPU instance tab...`);
          await cpuTab.click().catch(() => {});
          await this.sleep(500);
        }
      }

      // Click the confirmation "连接" (Connect) button in the modal
      const confirmConnectSelectors = [
        'button:has-text("连接")',
        'button.ant-btn-primary:has-text("连接")',
        'div[role="dialog"] button:has-text("连接")',
      ];

      for (const cSel of confirmConnectSelectors) {
        const confirmBtn = await page.$(cSel);
        if (confirmBtn && (await confirmBtn.isVisible())) {
          logger.info(`[${notebookConfig.name}] Clicking modal confirmation button '连接'...`);
          await confirmBtn.click({ timeout: 5000 });
          await this.sleep(4000);
          return true;
        }
      }

      return false;
    } catch (err) {
      logger.warn(`Error handling select instance modal: ${err.message}`);
      return false;
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
        // Touch document title or active timestamp
        window._modellive_last_heartbeat = Date.now();
      }).catch(() => {});
    } catch (err) {
      logger.warn(`User activity simulation minor error: ${err.message}`);
    }
  }
}

export default PageActions;
