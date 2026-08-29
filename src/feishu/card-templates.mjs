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
    let providerName = 'ModelScope 账号登录';
    if (provider === 'csdn') providerName = 'CSDN 扫码登录';
    else if (provider === 'github') providerName = 'GitHub 登录';
    else if (provider === 'aliyun') providerName = '阿里云扫码登录';
    else if (provider === 'ram') providerName = '阿里云 RAM 登录';

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `📱 ${providerName}` },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**当前方式**：**${providerName}**\n**提示**：${tip}\n完成扫码或授权后，会话凭证将自动永久保存在本地电脑 Profile 中，实现长效保活。` },
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
              text: { tag: 'plain_text', content: '✅ 我已完成登录' },
              type: 'primary',
              value: { action: 'confirm_login' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '☁️ 阿里云/RAM' },
              type: 'default',
              value: { action: 'trigger_login', provider: 'ram' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔴 CSDN 扫码' },
              type: 'default',
              value: { action: 'trigger_login', provider: 'csdn' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🐙 GitHub' },
              type: 'default',
              value: { action: 'trigger_login', provider: 'github' },
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
  static buildCaptchaCard(imageKey, tip = '请在手机滑动面板中完成验证', h5Url = '') {
    const elements = [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**检测到安全验证** 🧩\n${tip}\n\n💡 请点击下方【📱 打开手机实时滑动面板】，在手机上触摸拖动滑块，实时观察对齐并提交。`,
        },
      },
    ];

    if (h5Url) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📱 打开手机实时滑动面板 (推荐)' },
            type: 'primary',
            multi_url: {
              url: h5Url,
              pc_url: h5Url,
              android_url: h5Url,
              ios_url: h5Url,
            },
          },
        ],
      });
    }

    elements.push(
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
            text: { tag: 'plain_text', content: '🔄 刷新换一张' },
            type: 'default',
            value: { action: 'captcha_refresh' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 我已在电脑端完成' },
            type: 'default',
            value: { action: 'confirm_captcha' },
          },
        ],
      }
    );

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🧩 ModelScope 连接安全验证' },
        template: 'orange',
      },
      elements,
    };
  }

  /**
   * Build Slider Holding & Fine-Tuning Card (Slide and hold for user confirmation before release).
   * @param {string} imageKey
   * @param {number} currentPercent
   * @param {string} [h5Url='']
   */
  static buildSliderHoldingCard(imageKey, currentPercent, h5Url = '') {
    const elements = [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**滑块已移动至**: **\`${currentPercent.toFixed(1)}%\`** (电脑端当前处于【**按住未放开**】状态 🔒)\n\n📸 **上图为当前实时落点预览**：\n• 若缺口**未完全对齐**，请点击下方【微调按键】继续移动；\n• 若已**严丝合缝对齐**，请点击【✅ 确认对齐，放开滑块提交】完成验证！`,
        },
      },
      {
        tag: 'img',
        img_key: imageKey,
        alt: { tag: 'plain_text', content: 'Current Holding Slider Position' },
        mode: 'fit_horizontal',
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '◀ -2%' },
            type: 'default',
            value: { action: 'slider_adjust', delta: -2 },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '◀ -1%' },
            type: 'default',
            value: { action: 'slider_adjust', delta: -1 },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '◀ -0.5%' },
            type: 'default',
            value: { action: 'slider_adjust', delta: -0.5 },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '+0.5% ▶' },
            type: 'default',
            value: { action: 'slider_adjust', delta: 0.5 },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '+1% ▶' },
            type: 'default',
            value: { action: 'slider_adjust', delta: 1 },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '+2% ▶' },
            type: 'default',
            value: { action: 'slider_adjust', delta: 2 },
          },
        ],
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `✅ 确认对齐，放开滑块提交 (${currentPercent.toFixed(1)}%)` },
            type: 'primary',
            value: { action: 'slider_release' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 取消并重置' },
            type: 'danger',
            value: { action: 'slider_cancel' },
          },
        ],
      },
    ];

    if (h5Url) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📱 手机大按钮按键面板' },
            type: 'default',
            url: h5Url,
          },
        ],
      });
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `🎯 滑块落点预览: ${currentPercent.toFixed(1)}% (按住中)` },
        template: 'turquoise',
      },
      elements,
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
            content: `**可用指令列表**：\n\n• \`/status\` 或 \`状态\`：查看所有 Notebook 实例的保活健康度\n• \`/refresh\` 或 \`保活\`：立即执行一次全量保活刷新\n• \`/start [CPU|GPU]\` 或 \`启动\`：远程连接并启动指定的实例类型\n• \`查看实例\` 或 \`/instance\`：打开顶部菜单【查看实例】(PAI-DSW/阿里云登录)\n• \`/login\` 或 \`登录\`：获取最新 ModelScope 微信/CSDN 登录二维码\n• \`/cookie <cookie内容>\`：手动更新注入浏览器 Cookie\n• \`/logs\` 或 \`日志\`：获取最近运行日志\n• \`/help\` 或 \`帮助\`：查看此帮助说明`,
          },
        },
      ],
    };
  }

  /**
   * Build Alibaba Cloud PAI-DSW Instance Detail Card (or Login Prompt Card).
   * @param {string} imageKey
   * @param {boolean} needsLogin
   * @param {string} targetUrl
   * @param {string} [customMessage]
   */
  static buildInstanceDetailCard(imageKey, needsLogin = false, targetUrl = '', customMessage = '') {
    if (needsLogin) {
      return {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: '☁️ 阿里云 RAM 登录 (查看实例)' },
          template: 'orange',
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**状态**：🟡 **需登录阿里云 RAM 子账号**\n${customMessage || '已在电脑端自动切换至 RAM 登录页面。'}\n\n👉 **请直接在飞书发送账号密码进行登录**：\n• 一键登录：\`/ram <子账号> <密码>\`\n• 分步发送：\`/ram user <子账号>\` ➔ \`/ram pass <密码>\`\n• 若有验证码：\`/ram code <验证码>\``,
            },
          },
          {
            tag: 'img',
            img_key: imageKey,
            alt: { tag: 'plain_text', content: 'Alibaba Cloud RAM Login Screen' },
            mode: 'fit_horizontal',
          },
          { tag: 'hr' },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '🔄 刷新登录页面' },
                type: 'default',
                value: { action: 'ram_refresh' },
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '✅ 我已在电脑端完成登录' },
                type: 'primary',
                value: { action: 'confirm_aliyun_login' },
              },
            ],
          },
        ],
      };
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🖥️ 阿里云实例管理窗口 (PAI-DSW 已打开)' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**状态**：🟢 **阿里云已连接**\n${customMessage || '已在电脑端成功打开【查看实例】控制台窗口！您可在该窗口中使用全部高级实例功能。'}\n\n💻 PC 守护进程正在持续全天候保活中。`,
          },
        },
        {
          tag: 'img',
          img_key: imageKey,
          alt: { tag: 'plain_text', content: 'PAI-DSW Console Screenshot' },
          mode: 'fit_horizontal',
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔄 刷新实例详情' },
              type: 'primary',
              value: { action: 'view_instance' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '📊 查看保活看板' },
              type: 'default',
              value: { action: 'view_status' },
            },
          ],
        },
      ],
    };
  }

  /**
   * Build RAM Login Step Status Card with screenshot & step guidance.
   * @param {string} imageKey
   * @param {string} title
   * @param {string} message
   * @param {'blue' | 'orange' | 'green' | 'red'} [color='blue']
   */
  static buildRamLoginStatusCard(imageKey, title, message, color = 'blue') {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `☁️ 阿里云 RAM: ${title}` },
        template: color,
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `${message}\n\n**可用指令**：\n• 一键登录：\`/ram <子账号> <密码>\`\n• 输入账号：\`/ram user <子账号>\`\n• 输入密码：\`/ram pass <密码>\`\n• 输入验证码：\`/ram code <验证码>\``,
          },
        },
        {
          tag: 'img',
          img_key: imageKey,
          alt: { tag: 'plain_text', content: 'RAM Login Screenshot' },
          mode: 'fit_horizontal',
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔄 刷新登录状态' },
              type: 'default',
              value: { action: 'ram_refresh' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 我已在电脑完成登录' },
              type: 'primary',
              value: { action: 'confirm_aliyun_login' },
            },
          ],
        },
      ],
    };
  }
  /**
   * Build image message card with title and text.
   * @param {string} imageKey
   * @param {string} title
   * @param {string} message
   * @param {string} [color='blue']
   */
  static buildImageCard(imageKey, title, message, color = 'blue') {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template: color,
      },
      elements: [
        {
          tag: 'img',
          img_key: imageKey,
          alt: { tag: 'plain_text', content: title },
          mode: 'fit_horizontal',
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: message,
          },
        },
      ],
    };
  }
  /**
   * Build Launch Prompt Card (Option 1: Mobile Native + Option 2: Big-Button H5 Tuner).
   * @param {string} notebookName
   * @param {string} workspaceUrl
   * @param {string} h5Url
   */
  static buildLaunchPromptCard(notebookName = 'ModelScope工作空间', workspaceUrl = 'https://www.modelscope.cn/code/workspace', h5Url = '') {
    const actions = [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '🌐 方案1: 手机打开官网(电脑模式)' },
        type: 'primary',
        url: workspaceUrl,
      },
    ];

    if (h5Url) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '📱 方案2: 手机大按钮按键微调' },
        type: 'default',
        multi_url: {
          url: h5Url,
          pc_url: h5Url,
          android_url: h5Url,
          ios_url: h5Url,
        },
      });
    }

    actions.push(
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '🔄 启动后立即检测接管' },
        type: 'default',
        value: { action: 'manual_refresh' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '📊 查看状态看板' },
        type: 'default',
        value: { action: 'view_status' },
      }
    );

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🚀 ModelScope 实例等待启动' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**工作空间**: **${notebookName}**\n**当前状态**: 🟡 尚未连接运行\n\n💡 **两种启动与验证方式任选**：\n• **方案 1（手机原生）**：点击【**方案1: 手机打开官网**】，在手机浏览器开启【电脑模式】后原生顺滑滑动；\n• **方案 2（按键微调）**：点击【**方案2: 手机大按钮按键微调**】，在手机上看标尺轻点按键完成滑动。\n\n启动成功后，PC 守护进程将**自动无缝接管 24/7 全自动保活**！`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions,
        },
      ],
    };
  }
}

export default CardTemplates;
