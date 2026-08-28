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
  static buildLoginQrCard(imageKey, tip = '请使用手机长按或扫码登录 ModelScope') {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '📱 ModelScope 移动端扫码登录' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**提示**：${tip}\n完成扫码后，系统将自动检测登录并同步 Cookie 恢复保活。` },
        },
        {
          tag: 'img',
          img_key: imageKey,
          alt: { tag: 'plain_text', content: 'ModelScope Login QR Code' },
          mode: 'fit_horizontal',
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 我已在网页完成登录' },
              type: 'primary',
              value: { action: 'confirm_login' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔁 重新获取二维码' },
              type: 'default',
              value: { action: 'trigger_login' },
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
            content: `**可用指令列表**：\n\n• \`/status\` 或 \`状态\`：查看所有 Notebook 实例的保活健康度\n• \`/refresh\` 或 \`保活\`：立即执行一次全量保活刷新\n• \`/login\` 或 \`登录\`：获取最新 ModelScope 登录二维码进行扫码登录\n• \`/cookie <cookie内容>\`：手动更新注入浏览器 Cookie\n• \`/logs\` 或 \`日志\`：获取最近运行日志\n• \`/help\` 或 \`帮助\`：查看此帮助说明`,
          },
        },
      ],
    };
  }
}

export default CardTemplates;
