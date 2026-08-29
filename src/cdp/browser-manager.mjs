import { chromium } from 'playwright-core';
import logger from '../logger.mjs';
import { launchChrome } from '../../scripts/start-chrome.mjs';

/**
 * Browser & CDP Session Manager
 */
export class BrowserManager {
  constructor(config = {}) {
    this.config = config;
    this.browser = null;
    this.context = null;
    this.notebookTabs = new Map(); // id -> page
    this.isConnected = false;
  }

  /**
   * Helper to sleep.
   */
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Test if CDP endpoint is reachable.
   * @param {string} endpoint
   * @returns {Promise<boolean>}
   */
  static async checkCdpReachable(endpoint = 'http://127.0.0.1:9222') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const url = new URL('/json/version', endpoint).toString();
      const res = await fetch(url, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Connect to browser via CDP, optionally auto-launching Chrome if needed.
   * @returns {Promise<boolean>}
   */
  async connect() {
    const cdpEndpoint = this.config.browser?.cdpEndpoint || 'http://127.0.0.1:9222';
    const autoLaunch = this.config.browser?.autoLaunch !== false;

    logger.cdp(`Checking CDP endpoint: ${cdpEndpoint}...`);
    let reachable = await BrowserManager.checkCdpReachable(cdpEndpoint);

    if (!reachable && autoLaunch) {
      logger.info(`CDP endpoint not responding. Attempting to launch local Chrome with remote debugging...`);
      launchChrome(this.config.browser?.browserPath);

      // Poll for up to 15 seconds for CDP to become ready
      const startPoll = Date.now();
      while (Date.now() - startPoll < 15000) {
        await BrowserManager.sleep(1000);
        reachable = await BrowserManager.checkCdpReachable(cdpEndpoint);
        if (reachable) {
          logger.success(`Chrome started and CDP port is now accessible.`);
          break;
        }
      }
    }

    if (!reachable) {
      throw new Error(`Cannot connect to CDP at ${cdpEndpoint}. Please start Chrome with --remote-debugging-port=9222 or run 'npm run chrome'.`);
    }

    try {
      logger.cdp(`Connecting to Chrome via CDP (${cdpEndpoint})...`);
      this.browser = await chromium.connectOverCDP(cdpEndpoint);
      const contexts = this.browser.contexts();
      this.context = contexts.length > 0 ? contexts[0] : await this.browser.newContext();
      this.isConnected = true;

      this.browser.on('disconnected', () => {
        logger.warn('Browser disconnected from CDP.');
        this.isConnected = false;
        this.browser = null;
        this.context = null;
        this.notebookTabs.clear();
      });

      logger.success('Successfully connected to Chrome via CDP.');
      return true;
    } catch (err) {
      this.isConnected = false;
      logger.error(`Failed to connect over CDP: ${err.message}`);
      throw err;
    }
  }

  /**
   * Ensure browser connection is alive.
   */
  async ensureConnected() {
    if (!this.isConnected || !this.browser) {
      await this.connect();
    }
  }

  /**
   * Get an existing tab matching the notebook or open a new one.
   * @param {object} notebookConfig
   * @returns {Promise<import('playwright-core').Page>}
   */
  async getOrCreateTab(notebookConfig) {
    await this.ensureConnected();

    // Check if we already have a cached live page
    const cachedPage = this.notebookTabs.get(notebookConfig.id);
    if (cachedPage && !cachedPage.isClosed()) {
      return cachedPage;
    }

    // Inspect existing pages in browser context to reuse
    const pages = this.context.pages();
    for (const p of pages) {
      if (!p.isClosed()) {
        const url = p.url();
        const title = await p.title().catch(() => '');
        if (
          (notebookConfig.url && url.includes(notebookConfig.url)) ||
          (notebookConfig.matchPattern && (url.includes(notebookConfig.matchPattern) || title.includes(notebookConfig.matchPattern)))
        ) {
          logger.cdp(`[${notebookConfig.name}] Reusing existing browser tab: ${url}`);
          this.notebookTabs.set(notebookConfig.id, p);
          return p;
        }
      }
    }

    // Open a new tab
    logger.cdp(`[${notebookConfig.name}] Opening new tab for ${notebookConfig.url}`);
    const newPage = await this.context.newPage();
    this.notebookTabs.set(notebookConfig.id, newPage);
    return newPage;
  }

  /**
   * Get primary/active page for general operations (like login check).
   * @returns {Promise<import('playwright-core').Page>}
   */
  async getPrimaryPage() {
    await this.ensureConnected();
    const pages = this.context.pages();
    for (const p of pages) {
      if (!p.isClosed() && p.url().includes('modelscope.cn')) {
        return p;
      }
    }
    if (pages.length > 0 && !pages[0].isClosed()) {
      return pages[0];
    }
    return await this.context.newPage();
  }

  /**
   * Get the active Alibaba Cloud (RAM / PAI-DSW) tab.
   * @returns {Promise<import('playwright-core').Page>}
   */
  async getAliyunPage() {
    await this.ensureConnected();
    const pages = this.context.pages();
    for (const p of pages) {
      if (!p.isClosed() && (p.url().includes('aliyun.com') || p.url().includes('dsw') || p.url().includes('pai'))) {
        return p;
      }
    }
    return await this.getPrimaryPage();
  }

  /**
   * Get an isolated background helper page for off-screen canvas rendering.
   * Never brought to front and does not touch workspace DOM.
   * @returns {Promise<import('playwright-core').Page>}
   */
  async getWorkerPage() {
    await this.ensureConnected();
    if (this.workerPage && !this.workerPage.isClosed()) {
      return this.workerPage;
    }
    this.workerPage = await this.context.newPage();
    await this.workerPage.goto('about:blank').catch(() => {});
    return this.workerPage;
  }

  /**
   * Disconnect from browser CDP session.
   */
  async disconnect() {
    if (this.workerPage && !this.workerPage.isClosed()) {
      await this.workerPage.close().catch(() => {});
      this.workerPage = null;
    }
    if (this.browser && this.isConnected) {
      try {
        await this.browser.close();
      } catch {
        // ignore
      }
    }
    this.isConnected = false;
    this.browser = null;
    this.context = null;
    this.notebookTabs.clear();
  }
}

export default BrowserManager;
