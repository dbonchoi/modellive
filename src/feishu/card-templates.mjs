/**
 * Feishu Interactive Message Card Templates
 */
export class CardTemplates {
  /**
   * Build status dashboard card.
   * @param {object} summary
   */
  static buildStatusCard(summary) {
    const items = summary.items || [];
    const fields = items.map(item => {
      const isOk = item.status === 'RUNNING';
      const icon = isOk ? '🟢' : (item.status === 'EXPIRED' ? '🔴' : '🟡');
      const timeStr = item.lastSuccessAt
        ? new Date(item.lastSuccessAt).toLocaleTimeString()
        : '未运行';
      return {
        is_short: false,
        text: {
          tag: 'lark_md',
          content: `${icon} **${item.name}**\n• 状态: \`${item.status}\` | 动作: \`${item.lastActionTaken}\`\n• 最近保活: ${timeStr} (${(item.lastDurationMs / 1000).toFixed(1)}s)\n• 成功/失败: **${item.totalSuccessCount}** / ${item.totalFailureCount}${item.lastError ? `\n• 最近异常: \`${item.lastError}\`` : ''}`,
        },
      };
    });

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '📊 ModelScope 保活状态看板' },
        template: summary.errors > 0 ? 'yellow' : 'green',
      },
      elements: [
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: { tag: 'lark_md', content: `**运行轮次**: #${summary.roundCount}` },
            },
            {
              is_short: true,
              text: { tag: 'lark_md', content: `**运行时间**: ${summary.uptime}` },
            },
            {
              is_short: true,
              text: { tag: 'lark_md', content: `**健康实例**: ${summary.running} / ${summary.totalNotebooks}` },
            },
            {
              is_short: true,
              text: { tag: 'lark_md', content: `**异常实例**: ${summary.errors}` },
            },
          ],
        },
        { tag: 'hr' },
        ...fields.map(f => ({ tag: 'div', fields: [f] })),
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔄 立即全量保活' },
              type: 'primary',
              value: { action: 'manual_refresh' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '📱 重新扫码登录' },
              type: 'default',
              value: { action: 'trigger_login' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '📋 查看最新日志' },
              type: 'default',
              value: { action: 'view_logs' },
            },
          ],
        },
      ],
    };
  }

  /**
   * Build Alert / Warning Card
   */
  static buildAlertCard(title, message, details = '') {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `🚨 ${title}` },
        template: 'red',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: message },
        },
        ...(details ? [
          {
            tag: 'note',
            elements: [{ tag: 'plain_text', content: `详情: ${details}` }],
          }
        ] : []),
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔄 尝试重新保活' },
              type: 'primary',
              value: { action: 'manual_refresh' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '📱 获取登录二维码' },
              type: 'danger',
              value: { action: 'trigger_login' },
            },
          ],
        },
      ],
    };
  }

  /**
   * Build Login QR Code Card
   */
  static buildLoginQrCard(imageKey, provider = 'csdn', tip = '请使用手机长按或扫码登录') {
    const providerName = provider === 'csdn' ? 'CSDN 扫码登录' : (provider === 'github' ? 'GitHub 登录' : 'ModelScope 账号登录');
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `📱 ModelScope 登录 [${providerName}]` },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**当前方式**：**${providerName}**\n**提示**：${tip}\n扫码授权后，系统将自动检测登录状态并同步会话继续保活。` },
        },
        {
          tag: 'img',
          img_key: imageKey,
          alt: { tag: 'plain_text', content: 'Login QR Code' },
          mode: 'fit_horizontal',
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 我已完成扫码' },
              type: 'primary',
              value: { action: 'confirm_login' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔴 CSDN 扫码' },
              type: 'default',
              value: { action: 'trigger_login', provider: 'csdn' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🐙 GitHub 登录' },
              type: 'default',
              value: { action: 'trigger_login', provider: 'github' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '📱 账号/短信' },
              type: 'default',
              value: { action: 'trigger_login', provider: 'default' },
            },
          ],
        },
      ],
    };
  }

  /**
   * Build Simple Action Result Card
   */
  static buildResultCard(title, message, isSuccess = true) {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `${isSuccess ? '✅' : '❌'} ${title}` },
        template: isSuccess ? 'green' : 'red',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: message },
        },
      ],
    };
  }

  /**
   * Build Captcha Slider Verification Card
   */
  static buildCaptchaCard(imageKey, tip = '请根据下方标尺图片选择滑块拖动比例') {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🧩 ModelScope 连接安全验证' },
        template: 'orange',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**已附带网格参考线与刻度标尺** 📐\n${tip}\n\n💡 **对照说明**：\n• 缺口或旋转物体在整张图横向对应的 **底部刻度（0%~100%）** 即为滑动比例\n• 可点击下方快捷比例或微调按钮，也可在聊天框直接输入 \`/slide <数值>\`（如 \`/slide 43\`）`,
          },
        },
        {
          tag: 'img',
          img_key: imageKey,
          alt: { tag: 'plain_text', content: 'Captcha Verification' },
          mode: 'fit_horizontal',
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '20%' },
              type: 'default',
              value: { action: 'slider_drag', percent: 20 },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '30%' },
              type: 'default',
              value: { action: 'slider_drag', percent: 30 },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '40%' },
              type: 'default',
              value: { action: 'slider_drag', percent: 40 },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '50%' },
              type: 'primary',
              value: { action: 'slider_drag', percent: 50 },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '60%' },
              type: 'default',
              value: { action: 'slider_drag', percent: 60 },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '70%' },
              type: 'default',
              value: { action: 'slider_drag', percent: 70 },
            },
          ],
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '⏪ -10%' },
              type: 'default',
              value: { action: 'slider_adjust', delta: -10 },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '◀️ -3%' },
              type: 'default',
              value: { action: 'slider_adjust', delta: -3 },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '▶️ +3%' },
              type: 'default',
              value: { action: 'slider_adjust', delta: 3 },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '⏩ +10%' },
              type: 'default',
              value: { action: 'slider_adjust', delta: 10 },
            },
          ],
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔄 刷新换一张' },
              type: 'default',
              value: { action: 'captcha_refresh' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 我已在电脑端完成' },
              type: 'primary',
              value: { action: 'confirm_captcha' },
            },
          ],
        },
      ],
    };
  }

  /**
   * Build Help Card
   */
  static buildHelpCard() {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '💡 ModelScope 保活助手指令菜单' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**可用指令列表**：\n\n• \`/status\` 或 \`状态\`：查看所有 Notebook 实例的保活健康度\n• \`/refresh\` 或 \`保活\`：立即执行一次全量保活刷新\n• \`/start [CPU|GPU|AMD]\` 或 \`启动\`：远程连接并启动指定的实例类型（默认 CPU）\n• \`/login\` 或 \`登录\`：获取最新 ModelScope 微信登录二维码进行扫码\n• \`/cookie <cookie内容>\`：手动更新注入浏览器 Cookie\n• \`/logs\` 或 \`日志\`：获取最近运行日志\n• \`/help\` 或 \`帮助\`：查看此帮助说明`,
          },
        },
      ],
    };
  }
}

export default CardTemplates;
