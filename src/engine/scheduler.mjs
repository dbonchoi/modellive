import logger from '../logger.mjs';
import { PageActions } from '../cdp/page-actions.mjs';
import { AuthDetector } from '../cdp/auth-detector.mjs';
import { stateStore } from './state-store.mjs';

/**
 * Scheduler for multi-notebook keepalive rounds.
 */
export class Scheduler {
  /**
   * @param {import('../cdp/browser-manager.mjs').BrowserManager} browserManager
   * @param {object} config
   */
  constructor(browserManager, config) {
    this.browserManager = browserManager;
    this.config = config;
    this.isRunning = false;
    this.isPaused = false;
    this.abortController = null;
    this.listeners = {
      roundComplete: [],
      loginExpired: [],
      error: [],
      recovery: [],
    };
  }

  on(event, handler) {
    if (this.listeners[event]) {
      this.listeners[event].push(handler);
    }
  }

  emit(event, data) {
    if (this.listeners[event]) {
      for (const handler of this.listeners[event]) {
        try {
          handler(data);
        } catch (err) {
          logger.error(`Error in event listener for ${event}: ${err.message}`);
        }
      }
    }
  }

  static sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  static calculateJitterMs(jitterMinutes = 0) {
    if (jitterMinutes <= 0) return 0;
    return Math.floor(Math.random() * jitterMinutes * 60 * 1000);
  }

  /**
   * Run a single keepalive round across all active notebooks.
   * @param {string} [specificId]
   * @param {object} [extraScheduleOptions={}]
   * @returns {Promise<{ total: number, succeeded: number, failed: number, results: any[] }>}
   */
  async runRound(specificId = null, extraScheduleOptions = {}) {
    const notebooks = this.config.notebooks.filter(nb => nb && nb.enabled !== false);
    const targetNotebooks = specificId
      ? notebooks.filter(nb => nb.id === specificId)
      : notebooks;

    if (targetNotebooks.length === 0) {
      logger.warn('No active notebooks found to process in this round.');
      return { total: 0, succeeded: 0, failed: 0, results: [] };
    }

    stateStore.roundCount += 1;
    const roundNumber = stateStore.roundCount;
    logger.engine(`=== Starting Keepalive Round #${roundNumber} (${targetNotebooks.length} notebooks) ===`);

    const results = [];
    const scheduleConfig = { ...(this.config.schedule || {}), gemini: this.config.gemini, ...(extraScheduleOptions || {}) };
    const perUrlDelayMs = (scheduleConfig.perUrlDelaySeconds || 5) * 1000;

    for (let i = 0; i < targetNotebooks.length; i += 1) {
      const nb = targetNotebooks[i];
      stateStore.initNotebook(nb);

      if (i > 0 && perUrlDelayMs > 0) {
        logger.engine(`Waiting ${(perUrlDelayMs / 1000).toFixed(1)}s before next notebook...`);
        await Scheduler.sleep(perUrlDelayMs, this.abortController?.signal);
      }

      try {
        const page = await this.browserManager.getOrCreateTab(nb);

        // Check authentication state
        const authCheck = await AuthDetector.checkLoginStatus(page);
        if (!authCheck.loggedIn) {
          logger.error(`[${nb.name}] ModelScope session is not logged in! (${authCheck.reason || 'Expired'})`);
          stateStore.recordFailure(nb.id, `Login expired: ${authCheck.reason}`, 0, true);
          this.emit('loginExpired', { notebook: nb, reason: authCheck.reason, page });
          results.push({ id: nb.id, ok: false, error: 'Login expired' });
          continue;
        }

        // Execute keepalive action
        const actionResult = await PageActions.execute(page, nb, scheduleConfig);

        if (actionResult.captchaBuffer) {
          stateStore.recordFailure(nb.id, 'Captcha verification required', actionResult.durationMs);
          this.emit('captchaRequired', { notebook: nb, buffer: actionResult.captchaBuffer, page });
          results.push({ id: nb.id, ok: false, error: 'Captcha verification required', captchaBuffer: actionResult.captchaBuffer });
        } else if (actionResult.success) {
          stateStore.recordSuccess(nb.id, actionResult);
          results.push({ id: nb.id, ok: true, ...actionResult });
        } else {
          stateStore.recordFailure(nb.id, actionResult.error, actionResult.durationMs);
          this.emit('error', { notebook: nb, error: actionResult.error });
          results.push({ id: nb.id, ok: false, error: actionResult.error });
        }
      } catch (err) {
        logger.error(`[${nb.name}] Unhandled exception during keepalive: ${err.message}`);
        stateStore.recordFailure(nb.id, err.message, 0);
        this.emit('error', { notebook: nb, error: err.message });
        results.push({ id: nb.id, ok: false, error: err.message });
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    const failed = results.length - succeeded;
    logger.engine(`=== Round #${roundNumber} Finished: ${succeeded}/${results.length} succeeded, ${failed} failed ===`);

    const summary = {
      roundNumber,
      total: results.length,
      succeeded,
      failed,
      results,
      summary: stateStore.getSummary(),
    };

    this.emit('roundComplete', summary);
    return summary;
  }

  /**
   * Start the recurring loop scheduler.
   */
  async startLoop() {
    this.isRunning = true;
    const schedule = this.config.schedule || {};

    while (this.isRunning) {
      this.abortController = new AbortController();

      try {
        await this.runRound();
      } catch (err) {
        logger.error(`Error executing round: ${err.message}`);
      }

      if (!this.isRunning) break;

      const baseIntervalMs = (schedule.intervalMinutes || 10) * 60 * 1000;
      const jitterMs = Scheduler.calculateJitterMs(schedule.jitterMinutes || 2);
      const totalWaitMs = baseIntervalMs + jitterMs;

      logger.engine(`Next round in ${((totalWaitMs) / 1000 / 60).toFixed(1)} minutes (Interval: ${schedule.intervalMinutes}m + Jitter: ${(jitterMs / 1000).toFixed(0)}s)...`);
      await Scheduler.sleep(totalWaitMs, this.abortController?.signal);
    }
  }

  /**
   * Stop loop execution.
   */
  stop() {
    this.isRunning = false;
    this.abortController?.abort();
    logger.engine('Keepalive scheduler stopped.');
  }
}

export default Scheduler;
