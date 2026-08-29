import logger from '../logger.mjs';
import { CardTemplates } from './card-templates.mjs';
import { AuthDetector } from '../cdp/auth-detector.mjs';
import { PageActions } from '../cdp/page-actions.mjs';
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
    this.lastSliderPercent = 50;
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

        // 1. Check if instance is already active and running
        try {
          const page = await this.browserManager.getPrimaryPage();
          const alreadyRunning = await PageActions.isInstanceRunning(page);
          if (alreadyRunning) {
            await this.notifier.sendCard(
              CardTemplates.buildResultCard('实例已在运行中', '🟢 当前 ModelScope 实例已在云端处于运行中状态，PC 守护进程正持续全自动保活，无需重复启动。', true),
              targetId
            );
            break;
          }
        } catch {}

        await this.notifier.sendCard(
          CardTemplates.buildResultCard('正在唤起实例连接', `收到启动指令，正在电脑端点击【连接运行时】并选择【${instanceType}】实例...`, true),
          targetId
        );

        try {
          if (this.scheduler.config.notebooks?.length > 0) {
            this.scheduler.config.notebooks[0].instanceType = instanceType;
          }
          const result = await this.scheduler.runRound(null, { forceStart: true });
          
          const captchaResult = result.results?.find(r => r.captchaBuffer || r.error === 'Captcha verification required');
          if (captchaResult && captchaResult.captchaBuffer) {
            await this.notifier.sendCaptchaCard(
              captchaResult.captchaBuffer,
              targetId,
              '已在电脑端唤起验证码！请点击下方按钮打开微调面板或使用离散滑块：'
            );
          } else if (result.succeeded > 0) {
            await this.notifier.sendText(
              `🎉 ModelScope 实例连接成功！PC 守护进程已自动无缝接管 24/7 全自动保活！`,
              targetId
            );
          } else {
            const nb = this.scheduler.config.notebooks?.[0] || { name: 'ModelScope工作空间', url: 'https://www.modelscope.cn/code/workspace' };
            await this.notifier.sendLaunchPrompt(nb.name, nb.url, targetId);
          }
        } catch (err) {
          await this.notifier.sendCard(
            CardTemplates.buildResultCard('启动实例异常', err.message, false),
            targetId
          );
        }
        break;
      }

      case '/slide':
      case 'slide':
      case '滑动':
      case '拖动': {
        const percent = Number(args[0]) || 45;
        this.lastSliderPercent = percent;
        await this.handleSlideAction(targetId, percent);
        break;
      }

      case '/release':
      case 'release':
      case '/confirm':
      case 'confirm':
      case '释放':
      case '松开':
      case '提交': {
        await this.handleReleaseAction(targetId);
        break;
      }

      case '/cancel':
      case 'cancel':
      case '取消':
      case '重置': {
        await this.handleCancelAction(targetId);
        break;
      }

      case '/instance':
      case 'instance':
      case '/dsw':
      case 'dsw':
      case '查看实例':
      case '/查看实例':
      case '实例详情': {
        await this.handleOpenInstanceDetail(targetId);
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

      case 'slider_drag': {
        const percent = Number(actionData.percent) || 50;
        this.lastSliderPercent = percent;
        await this.handleSlideAction(senderId, percent);
        break;
      }

      case 'slider_adjust': {
        const delta = Number(actionData.delta) || 0;
        const targetPercent = Math.max(0, Math.min(100, (this.lastSliderPercent || 50) + delta));
        this.lastSliderPercent = targetPercent;
        await this.handleSlideAction(senderId, targetPercent);
        break;
      }

      case 'slider_release': {
        await this.handleReleaseAction(senderId);
        break;
      }

      case 'slider_cancel': {
        await this.handleCancelAction(senderId);
        break;
      }

      case 'captcha_refresh': {
        try {
          const page = await this.browserManager.getPrimaryPage();
          const cap = await PageActions.refreshCaptcha(page);
          if (cap.buffer) {
            await this.notifier.sendCaptchaCard(cap.buffer, senderId, '已刷新验证码图片，请重新选择滑动比例');
          } else {
            await this.notifier.sendCard(CardTemplates.buildResultCard('验证码已消失', '未检测到验证码弹窗，可能已自动通过。', true), senderId);
          }
        } catch (err) {
          await this.notifier.sendCard(CardTemplates.buildResultCard('刷新验证码失败', err.message, false), senderId);
        }
        break;
      }

      case 'confirm_captcha': {
        try {
          const page = await this.browserManager.getPrimaryPage();
          const cap = await PageActions.checkAndCaptureCaptcha(page);
          if (!cap.visible) {
            await this.notifier.sendCard(CardTemplates.buildResultCard('验证通过', '🎉 验证已完成！正在恢复实例连接...', true), senderId);
            await this.scheduler.runRound();
          } else {
            await this.notifier.sendCaptchaCard(cap.buffer, senderId, '未检测到验证通过，请继续完成滑动');
          }
        } catch (err) {
          await this.notifier.sendCard(CardTemplates.buildResultCard('检测失败', err.message, false), senderId);
        }
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

      case 'view_status': {
        const summary = stateStore.getSummary();
        const card = CardTemplates.buildStatusCard(summary);
        await this.notifier.sendCard(card, senderId);
        break;
      }

      case 'view_instance':
      case 'confirm_aliyun_login': {
        await this.handleOpenInstanceDetail(senderId);
        break;
      }

      default:
        logger.warn(`Unknown card action: ${action}`);
        break;
    }
  }

  /**
   * Handle remote slider drag and hold action.
   * @param {string} targetId
   * @param {number} percent
   */
  async handleSlideAction(targetId, percent) {
    try {
      const page = await this.browserManager.getPrimaryPage();
      const holdRes = await PageActions.dragAndHold(page, percent);

      if (holdRes.success && holdRes.buffer) {
        await this.notifier.sendSliderHoldingCard(holdRes.buffer, percent, targetId);
      } else {
        await this.notifier.sendCard(
          CardTemplates.buildResultCard('滑动处理异常', holdRes.message || '未能成功按住滑块', false),
          targetId
        );
      }
    } catch (err) {
      await this.notifier.sendCard(CardTemplates.buildResultCard('滑动异常', err.message, false), targetId);
    }
  }

  /**
   * Handle user confirmation release of slider.
   * @param {string} targetId
   */
  async handleReleaseAction(targetId) {
    try {
      const page = await this.browserManager.getPrimaryPage();
      const res = await PageActions.releaseSlider(page);

      if (res.success) {
        await this.notifier.sendCard(
          CardTemplates.buildResultCard('🎉 滑块验证通过', res.message, true),
          targetId
        );
        await this.scheduler.runRound();
      } else {
        await this.notifier.sendCard(
          CardTemplates.buildResultCard('⚠️ 滑块验证未通过', res.message, false),
          targetId
        );
        if (res.newCaptchaBuffer) {
          await this.notifier.sendCaptchaCard(
            res.newCaptchaBuffer,
            targetId,
            '已重置新验证码，请点击下方预设或微调按钮重新滑动：'
          );
        }
      }
    } catch (err) {
      await this.notifier.sendCard(CardTemplates.buildResultCard('释放滑块异常', err.message, false), targetId);
    }
  }

  /**
   * Handle cancel and reset drag.
   * @param {string} targetId
   */
  async handleCancelAction(targetId) {
    try {
      const page = await this.browserManager.getPrimaryPage();
      const cap = await PageActions.cancelDrag(page);
      if (cap.buffer) {
        await this.notifier.sendCaptchaCard(cap.buffer, targetId, '已取消当前滑动并刷新验证码图片');
      } else {
        await this.notifier.sendCard(CardTemplates.buildResultCard('已重置', '已释放并重置滑块状态。', true), targetId);
      }
    } catch (err) {
      await this.notifier.sendCard(CardTemplates.buildResultCard('取消操作异常', err.message, false), targetId);
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

  /**
   * Handle opening Alibaba Cloud PAI-DSW instance detail or login prompt.
   * @param {string} targetId
   */
  async handleOpenInstanceDetail(targetId) {
    try {
      await this.notifier.sendCard(
        CardTemplates.buildResultCard('正在打开查看实例', '正在电脑端点击顶部【实例运行中】并进入【查看实例】窗口...', true),
        targetId
      );

      const page = await this.browserManager.getPrimaryPage();
      const res = await PageActions.openInstanceDetail(page);

      if (res.buffer) {
        const imageKey = await this.notifier.uploadImage(res.buffer);
        if (imageKey) {
          const card = CardTemplates.buildInstanceDetailCard(imageKey, res.needsLogin, res.targetUrl, res.message);
          await this.notifier.sendCard(card, targetId);
          return;
        }
      }

      await this.notifier.sendCard(
        CardTemplates.buildResultCard(
          res.needsLogin ? '需登录阿里云' : (res.success ? '实例管理窗口已打开' : '查看实例失败'),
          res.message,
          res.success && !res.needsLogin
        ),
        targetId
      );
    } catch (err) {
      await this.notifier.sendCard(
        CardTemplates.buildResultCard('查看实例异常', err.message, false),
        targetId
      );
    }
  }
}

export default MessageHandler;
