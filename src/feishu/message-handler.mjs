import logger from '../logger.mjs';
import { CardTemplates } from './card-templates.mjs';
import { AuthDetector } from '../cdp/auth-detector.mjs';
import { stateStore } from '../engine/state-store.mjs';

/**
 * Handles Feishu user commands and card button actions.
 */
export class MessageHandler {
  /**
   * @param {object} context
   * @param {import('./notifier.mjs').FeishuNotifier} context.notifier
   * @param {import('../engine/scheduler.mjs').Scheduler} context.scheduler
   * @param {import('../cdp/browser-manager.mjs').BrowserManager} context.browserManager
   */
  constructor({ notifier, scheduler, browserManager }) {
    this.notifier = notifier;
    this.scheduler = scheduler;
    this.browserManager = browserManager;
  }

  /**
   * Process incoming text message.
   */
  async handleTextCommand(text, senderId, chatId) {
    const raw = (text || '').trim();
    const [cmd, ...args] = raw.split(/\s+/);
    const targetId = senderId || chatId;

    logger.feishu(`Processing command: "${raw}" from ${targetId}`);

    switch (cmd.toLowerCase()) {
      case '/status':
      case 'status':
      case '状态':
      case '查询': {
        const summary = stateStore.getSummary();
        const card = CardTemplates.buildStatusCard(summary);
        await this.notifier.sendCard(card, targetId);
        break;
      }

      case '/refresh':
      case 'refresh':
      case '保活':
      case '刷新': {
        await this.notifier.sendCard(
          CardTemplates.buildResultCard('保活任务触发', '正在执行即时保活检测，请稍候...', true),
          targetId
        );

        try {
          const result = await this.scheduler.runRound();
          const card = CardTemplates.buildStatusCard(result.summary);
          await this.notifier.sendCard(card, targetId);
        } catch (err) {
          await this.notifier.sendCard(
            CardTemplates.buildResultCard('保活执行失败', err.message, false),
            targetId
          );
        }
        break;
      }

      case '/start':
      case 'start':
      case '/connect':
      case 'connect':
      case '启动':
      case '连接': {
        const instanceType = args[0] ? args[0].toUpperCase() : 'CPU';
        await this.notifier.sendCard(
          CardTemplates.buildResultCard('启动实例指令', `收到启动指令，正在尝试连接【${instanceType}】实例...`, true),
          targetId
        );

        try {
          // Temporarily set or ensure instanceType on first notebook
          if (this.scheduler.config.notebooks.length > 0) {
            this.scheduler.config.notebooks[0].instanceType = instanceType;
          }
          const result = await this.scheduler.runRound();
          const card = CardTemplates.buildStatusCard(result.summary);
          await this.notifier.sendCard(card, targetId);
        } catch (err) {
          await this.notifier.sendCard(
            CardTemplates.buildResultCard('启动实例失败', err.message, false),
            targetId
          );
        }
        break;
      }

      case '/login':
      case 'login':
      case '登录':
      case '重新登录': {
        const provider = args[0] ? args[0].toLowerCase() : (this.scheduler?.config?.loginProvider || 'csdn');
        await this.triggerLoginQRCodeFlow(targetId, provider);
        break;
      }

      case '/cookie':
      case 'cookie': {
        const cookieStr = args.join(' ');
        if (!cookieStr) {
          await this.notifier.sendCard(
            CardTemplates.buildResultCard('Cookie 注入失败', '请提供有效的 Cookie 字符串，格式如：\n`/cookie _m_h5_tk=xxx; token=yyy`', false),
            targetId
          );
          return;
        }

        try {
          await this.browserManager.ensureConnected();
          const injectResult = await AuthDetector.injectCookies(this.browserManager.context, cookieStr);
          if (injectResult.success) {
            await this.notifier.sendCard(
              CardTemplates.buildResultCard('Cookie 注入成功', `已成功注入 ${injectResult.count} 个 Cookie！正在重新执行保活验证...`, true),
              targetId
            );
            await this.scheduler.runRound();
          } else {
            await this.notifier.sendCard(
              CardTemplates.buildResultCard('Cookie 注入失败', injectResult.error || '未知错误', false),
              targetId
            );
          }
        } catch (err) {
          await this.notifier.sendCard(
            CardTemplates.buildResultCard('Cookie 处理异常', err.message, false),
            targetId
          );
        }
        break;
      }

      case '/logs':
      case 'logs':
      case '日志': {
        const lines = logger.getRecentLogs(15);
        const logContent = lines.length > 0 ? `\`\`\`text\n${lines.join('\n')}\n\`\`\`` : '暂无日志记录';
        await this.notifier.sendCard({
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: '📋 最近保活日志' },
            template: 'blue',
          },
          elements: [
            {
              tag: 'div',
              text: { tag: 'lark_md', content: logContent },
            },
          ],
        }, targetId);
        break;
      }

      case '/help':
      case 'help':
      case '帮助':
      default: {
        const card = CardTemplates.buildHelpCard();
        await this.notifier.sendCard(card, targetId);
        break;
      }
    }
  }

  /**
   * Handle card button clicks.
   */
  async handleCardAction(actionData, senderId) {
    const action = actionData.action;
    logger.feishu(`Card action clicked: "${action}" by ${senderId}`);

    switch (action) {
      case 'manual_refresh': {
        await this.notifier.sendCard(
          CardTemplates.buildResultCard('保活任务触发', '正在为您刷新所有 Notebook 实例...', true),
          senderId
        );
        const res = await this.scheduler.runRound();
        await this.notifier.sendCard(CardTemplates.buildStatusCard(res.summary), senderId);
        break;
      }

      case 'trigger_login': {
        const provider = actionData.provider || this.scheduler?.config?.loginProvider || 'csdn';
        await this.triggerLoginQRCodeFlow(senderId, provider);
        break;
      }

      case 'confirm_login': {
        try {
          const page = await this.browserManager.getPrimaryPage();
          const check = await AuthDetector.checkLoginStatus(page);
          if (check.loggedIn) {
            await this.notifier.sendCard(
              CardTemplates.buildResultCard('登录验证成功', '🎉 登录态已确认有效，正在继续保活循环...', true),
              senderId
            );
            await this.scheduler.runRound();
          } else {
            await this.notifier.sendCard(
              CardTemplates.buildResultCard('尚未检测到登录', `未检测到有效登录态 (${check.reason || '未就绪'})，请确认已扫码并在网页中完成授权。`, false),
              senderId
            );
          }
        } catch (err) {
          await this.notifier.sendCard(
            CardTemplates.buildResultCard('验证失败', err.message, false),
            senderId
          );
        }
        break;
      }

      case 'view_logs': {
        const lines = logger.getRecentLogs(15);
        const logContent = lines.length > 0 ? `\`\`\`text\n${lines.join('\n')}\n\`\`\`` : '暂无日志记录';
        await this.notifier.sendCard({
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: '📋 最近保活日志' },
            template: 'blue',
          },
          elements: [
            {
              tag: 'div',
              text: { tag: 'lark_md', content: logContent },
            },
          ],
        }, senderId);
        break;
      }

      default:
        logger.warn(`Unknown card action: ${action}`);
        break;
    }
  }

  /**
   * Capture and push login QR code for specific provider.
   * @param {string} senderId
   * @param {'csdn' | 'github' | 'default'} [provider='csdn']
   */
  async triggerLoginQRCodeFlow(senderId, provider = 'csdn') {
    try {
      const providerName = provider === 'csdn' ? 'CSDN 扫码' : (provider === 'github' ? 'GitHub' : 'ModelScope 账号');
      await this.notifier.sendCard(
        CardTemplates.buildResultCard('正在获取二维码', `正在连接浏览器并打开 ModelScope【${providerName}】登录页面...`, true),
        senderId
      );

      const page = await this.browserManager.getPrimaryPage();
      const qrResult = await AuthDetector.captureLoginQRCode(page, provider);

      if (qrResult.buffer) {
        await this.notifier.sendLoginQRCode(qrResult.buffer, senderId, qrResult.providerUsed);
      } else {
        await this.notifier.sendCard(
          CardTemplates.buildResultCard('获取二维码失败', qrResult.error || '未能抓取到登录二维码，请检查本地 Chrome 状态。', false),
          senderId
        );
      }
    } catch (err) {
      await this.notifier.sendCard(
        CardTemplates.buildResultCard('登录流异常', err.message, false),
        senderId
      );
    }
  }
}

export default MessageHandler;
