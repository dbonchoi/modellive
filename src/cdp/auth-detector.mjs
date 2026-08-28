import logger from '../logger.mjs';

/**
 * Authentication detector and QR code grabber for ModelScope.
 */
export class AuthDetector {
  /**
   * Check if current page is in logged-in state.
   * @param {import('playwright-core').Page} page
   * @returns {Promise<{ loggedIn: boolean, reason?: string }>}
   */
  static async checkLoginStatus(page) {
    try {
      const url = page.url();
      if (!url || url === 'about:blank') {
        return { loggedIn: false, reason: 'Blank page' };
      }

      // 1. Check if URL matches login/auth/oauth pages
      if (
        url.includes('/login') ||
        url.includes('/user/login') ||
        url.includes('passport.') ||
        url.includes('oauth')
      ) {
        return { loggedIn: false, reason: 'Current URL is a login/auth page' };
      }

      // 2. Check if login prompt / login form / login buttons are visible
      const loginIndicators = [
        'button:has-text("登录")',
        'a:has-text("登录")',
        'button:has-text("Sign in")',
        'input[placeholder*="账号"]',
        'input[placeholder*="密码"]',
        'input[type="password"]',
        'div:has-text("其他登录方式")',
        'a[href*="/login"]',
      ];

      for (const sel of loginIndicators) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            return { loggedIn: false, reason: `Login element visible (${sel})` };
          }
        } catch {
          // ignore
        }
      }

      // 3. Check for genuine ModelScope authenticated user elements (avatar, user dropdown)
      const userProfileSelectors = [
        '.user-avatar',
        '.header-avatar',
        '[data-testid="user-menu"]',
        'img.ant-avatar-image',
        'div.ant-avatar-image',
        'button[class*="user-center"]',
        'div[class*="userProfile"]',
      ];

      for (const sel of userProfileSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            return { loggedIn: true, reason: 'User avatar element found' };
          }
        } catch {
          // ignore
        }
      }

      // 4. Check real authentication cookies (exclude anonymous tracking cookies like _m_h5_tk, isg, cna)
      const cookies = await page.context().cookies('https://www.modelscope.cn');
      const authCookieNames = [
        'login_aliyunid_ticket',
        'login_aliyunid_csrf',
        'havana_sdk_sess',
        'modelscope_user_token',
        'MS_TOKEN',
        'sdk_user_token',
        '_ms_login_session',
      ];

      const hasAuthCookie = cookies.some(c => authCookieNames.includes(c.name) && c.value);
      if (hasAuthCookie) {
        return { loggedIn: true, reason: 'Verified auth session cookies' };
      }

      // If on workspace / code editor and no login button is visible, check if workspace container is loaded
      if (url.includes('/code/workspace')) {
        const workspaceContainer = await page.$('.monaco-workbench, .jp-Notebook, div:has-text("Code Editor")');
        if (workspaceContainer && (await workspaceContainer.isVisible())) {
          return { loggedIn: true, reason: 'Workspace workbench active' };
        }
      }

      return { loggedIn: false, reason: 'No valid user session or avatar detected' };
    } catch (err) {
      logger.warn(`Failed to inspect login status: ${err.message}`);
      return { loggedIn: false, reason: err.message };
    }
  }

  /**
   * Navigate to login page, select login provider (CSDN, GitHub, etc.), and capture the QR code.
   * @param {import('playwright-core').Page} page
   * @param {'csdn' | 'github' | 'wechat' | 'default'} [provider='csdn']
   * @returns {Promise<{ buffer: Buffer | null, providerUsed: string, error?: string }>}
   */
  static async captureLoginQRCode(page, provider = 'csdn') {
    const selectedProvider = (provider || 'csdn').toLowerCase();
    logger.cdp(`Navigating to ModelScope login page for provider: "${selectedProvider}"...`);

    try {
      await page.goto('https://www.modelscope.cn/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Handle third-party providers (CSDN, GitHub, etc.)
      if (selectedProvider === 'csdn') {
        logger.info('Looking for CSDN login button...');
        const csdnSelectors = [
          'img[src*="csdn" i]',
          'svg[class*="csdn" i]',
          'a[href*="csdn" i]',
          'div[class*="other"] img:nth-child(1)',
          'div:has-text("其他登录方式") ~ * img:first-child',
          'div:has-text("其他登录方式") img:first-child',
          '[class*="csdn" i]',
        ];

        let clickedCsdn = false;
        for (const sel of csdnSelectors) {
          try {
            const btn = await page.$(sel);
            if (btn && (await btn.isVisible())) {
              logger.success(`Found CSDN login button (${sel}), clicking...`);
              await btn.click();
              clickedCsdn = true;
              break;
            }
          } catch {
            // continue
          }
        }

        if (!clickedCsdn) {
          // Fallback: click first icon under "其他登录方式"
          const otherContainer = await page.$('div:has-text("其他登录方式")');
          if (otherContainer) {
            const firstImg = await otherContainer.$('img');
            if (firstImg) {
              logger.info('Clicking first icon under 其他登录方式 (CSDN)...');
              await firstImg.click();
              clickedCsdn = true;
            }
          }
        }

        if (clickedCsdn) {
          logger.info('Waiting for CSDN authorization / WeChat QR code page to load...');
          await page.waitForTimeout(3000);
          await page.waitForLoadState('domcontentloaded').catch(() => {});
        }
      } else if (selectedProvider === 'github') {
        logger.info('Looking for GitHub login button...');
        const ghSelectors = [
          'img[src*="github" i]',
          'a[href*="github" i]',
          'svg[class*="github" i]',
          'div[class*="other"] img:nth-child(2)',
        ];
        for (const sel of ghSelectors) {
          try {
            const btn = await page.$(sel);
            if (btn && (await btn.isVisible())) {
              await btn.click();
              await page.waitForTimeout(3000);
              break;
            }
          } catch {
            // continue
          }
        }
      }

      // Look for QR code elements on the current page (ModelScope, CSDN passport, WeChat QR, etc.)
      const qrSelectors = [
        // CSDN specific QR code containers
        '.main-code img',
        '.main-code canvas',
        '.login-code img',
        '.qrcode-img',
        '#login-qrcode img',
        '#login-qrcode canvas',
        'canvas[class*="qrcode"]',
        'img[class*="qrcode"]',
        'img[src*="qrcode"]',
        'img[src*="weixin"]',
        'img[src*="qr"]',
        'div[class*="qrcode"] canvas',
        'div[class*="qrcode"] img',
        'div[class*="qr-code"]',
        '.login-box',
        '.main-container',
        'div[class*="loginModal"]',
        'div[class*="loginForm"]',
      ];

      let qrElement = null;
      for (const sel of qrSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            qrElement = el;
            logger.success(`Matched QR element: ${sel}`);
            break;
          }
        } catch {
          // continue
        }
      }

      if (!qrElement) {
        logger.warn('Specific QR element not isolated, capturing page viewport screenshot...');
        const buffer = await page.screenshot({ fullPage: false, type: 'png' });
        return { buffer, providerUsed: selectedProvider };
      }

      const buffer = await qrElement.screenshot({ type: 'png' });
      logger.success('Login QR code screenshot captured successfully.');
      return { buffer, providerUsed: selectedProvider };
    } catch (err) {
      logger.error(`Error capturing QR code for provider ${selectedProvider}: ${err.message}`);
      return { buffer: null, providerUsed: selectedProvider, error: err.message };
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
