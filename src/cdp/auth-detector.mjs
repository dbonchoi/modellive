import logger from '../logger.mjs';

/**
 * Authentication detector and QR code grabber for ModelScope.
 */
export class AuthDetector {
  /**
   * Check if current page is in logged-in state.
   * ModelScope shows user avatar or user center icon when logged in,
   * and login button / login modal / redirect to /login when not logged in.
   * @param {import('playwright-core').Page} page
   * @returns {Promise<{ loggedIn: boolean, reason?: string }>}
   */
  static async checkLoginStatus(page) {
    try {
      const url = page.url();
      if (url.includes('/login') || url.includes('/user/login')) {
        return { loggedIn: false, reason: 'URL matches login page' };
      }

      // Check for common ModelScope logged-in indicators
      // e.g. user avatar, user profile dropdown, or workspace table/cards
      const loggedInSelectors = [
        '.user-avatar',
        '.header-avatar',
        '[data-testid="user-menu"]',
        'div[class*="avatar"]',
        'div[class*="userProfile"]',
        'button[class*="user-center"]',
      ];

      for (const sel of loggedInSelectors) {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) return { loggedIn: true };
        }
      }

      // Check if login button is prominently displayed
      const loginBtnSelectors = [
        'button:has-text("登录")',
        'a:has-text("登录")',
        'button:has-text("Sign in")',
        'a[href*="/login"]',
      ];

      for (const sel of loginBtnSelectors) {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            return { loggedIn: false, reason: 'Login button is visible' };
          }
        }
      }

      // Check if cookies contain ModelScope auth tokens
      const cookies = await page.context().cookies('https://www.modelscope.cn');
      const hasAuthCookie = cookies.some(c => 
        ['_m_h5_tk', 'token', 'login_token', 'havana_sdk_sess', 'isg'].includes(c.name)
      );

      return { loggedIn: hasAuthCookie, reason: hasAuthCookie ? 'Auth cookies found' : 'Ambiguous state' };
    } catch (err) {
      logger.warn(`Failed to inspect login status: ${err.message}`);
      return { loggedIn: false, reason: err.message };
    }
  }

  /**
   * Navigate to login page and capture the login QR code if present.
   * @param {import('playwright-core').Page} page
   * @returns {Promise<{ buffer: Buffer | null, error?: string }>}
   */
  static async captureLoginQRCode(page) {
    try {
      logger.cdp('Navigating to ModelScope login page to grab QR code...');
      await page.goto('https://www.modelscope.cn/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Check if WeChat QR login tab/button is present and click to activate WeChat QR code
      const wechatTabSelectors = [
        'div:has-text("微信扫码")',
        'span:has-text("微信扫码")',
        'button:has-text("微信登录")',
        'div[class*="wechat"]',
        'div:has-text("微信")',
        'a:has-text("微信")',
      ];

      for (const wSel of wechatTabSelectors) {
        try {
          const wTab = await page.$(wSel);
          if (wTab && (await wTab.isVisible())) {
            logger.info('Switching to WeChat QR code login tab...');
            await wTab.click().catch(() => {});
            await page.waitForTimeout(1000);
            break;
          }
        } catch {
          // ignore
        }
      }

      // ModelScope / WeChat login modal / iframe / QR code container
      const qrSelectors = [
        'canvas[class*="qrcode"]',
        'img[class*="qrcode"]',
        'img[src*="qrcode"]',
        'img[src*="weixin"]',
        'img[src*="wx"]',
        'div[class*="qrcode"]',
        'div[class*="qr-code"]',
        '#login-qrcode',
        '.login-qr',
        'iframe[id*="alibaba-login-box"]',
        'iframe[src*="login"]',
      ];

      let qrElement = null;
      for (const sel of qrSelectors) {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            qrElement = el;
            break;
          }
        }
      }

      if (!qrElement) {
        // Fallback: take full page or main login box screenshot
        logger.warn('Specific QR code element not matched directly; capturing login container or viewport screenshot...');
        const buffer = await page.screenshot({ fullPage: false, type: 'png' });
        return { buffer };
      }

      const buffer = await qrElement.screenshot({ type: 'png' });
      logger.success('Login QR code screenshot captured successfully.');
      return { buffer };
    } catch (err) {
      logger.error(`Error capturing QR code: ${err.message}`);
      return { buffer: null, error: err.message };
    }
  }

  /**
   * Inject cookie strings or objects into the browser context.
   * @param {import('playwright-core').BrowserContext} context
   * @param {string | object[]} cookieData
   * @returns {Promise<{ success: boolean, count: number, error?: string }>}
   */
  static async injectCookies(context, cookieData) {
    try {
      const cookiesToSet = [];

      if (typeof cookieData === 'string') {
        // Parse cookie header string format: "key1=val1; key2=val2"
        const pairs = cookieData.split(';').map(s => s.trim()).filter(Boolean);
        for (const pair of pairs) {
          const idx = pair.indexOf('=');
          if (idx > 0) {
            const name = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1).trim();
            cookiesToSet.push({
              name,
              value,
              domain: '.modelscope.cn',
              path: '/',
              secure: true,
            });
          }
        }
      } else if (Array.isArray(cookieData)) {
        for (const item of cookieData) {
          if (item && item.name && item.value) {
            cookiesToSet.push({
              domain: item.domain || '.modelscope.cn',
              path: item.path || '/',
              ...item,
            });
          }
        }
      }

      if (cookiesToSet.length === 0) {
        return { success: false, count: 0, error: 'No valid cookies found to inject' };
      }

      await context.addCookies(cookiesToSet);
      logger.success(`Successfully injected ${cookiesToSet.length} cookie(s) into browser context.`);
      return { success: true, count: cookiesToSet.length };
    } catch (err) {
      logger.error(`Failed to inject cookies: ${err.message}`);
      return { success: false, count: 0, error: err.message };
    }
  }
}

export default AuthDetector;
