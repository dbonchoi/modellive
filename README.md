# ModelScope Notebook Keepalive Daemon (modellive)

基于 **CDP (Chrome DevTools Protocol)** 与 **飞书长连接 (WebSocket)** 的 ModelScope（魔搭社区）Notebook 多实例自动保活守护进程。

---

## 🌟 核心特性

- 🔄 **多 Notebook 轮询保活**：支持配置多个 ModelScope Notebook 实例，顺序平滑轮询，防止多开拥堵。
- 🌐 **基于 CDP 复用本地会话**：通过 Chrome 远程调试端口连接，无需逆向复杂滑块与短信登录，安全稳定。
- 🤖 **飞书深度集成（免公网 IP / 免内网穿透）**：
  - 基于飞书官方 WebSocket 长连接，在内网或本地电脑均可直接双向通信。
  - **状态与异常卡片通知**：定时推送健康度看板，异常断开/停止即时报警。
  - **人机交互问答**：在飞书对话框发送 `/status`、`/refresh`、`/logs`、`/help` 进行交互式查询与控制。
- 📱 **移动端扫码重新登录 & Cookie 注入**：
  - 登录失效时自动截取登录二维码并推送到手机飞书。
  - 用户可在手机端扫码授权，本地脚本自动识别登录成功并无缝恢复保活。
  - 支持手机飞书直接发送 `/cookie` 字符串快速注入更新会话。
- ⚙️ **配置热重载与守护进程**：支持运行时热读取 `keepalive.config.json`，支持后台 Daemon 与 PID 管理。

---

## 🛠️ 快速上手

### 1. 环境准备

确保已安装 **Node.js (>= 18.0.0)**：

```bash
# 克隆并进入项目目录
cd modellive

# 安装依赖
npm install
```

### 2. 配置说明 (`keepalive.config.json`)

复制或编辑 `keepalive.config.json`：

```json
{
  "feishu": {
    "enabled": false,
    "appId": "cli_xxxxxxxxxxxxxx",
    "appSecret": "your_app_secret_here",
    "botName": "ModelScope保活助手",
    "receiveMode": "websocket",
    "notifyOnSuccessIntervalRounds": 6,
    "notifyOnFailure": true,
    "adminUserIds": ["ou_xxxxxxxxxxxxxx"]
  },
  "browser": {
    "cdpEndpoint": "http://127.0.0.1:9222",
    "autoLaunch": true,
    "browserPath": "",
    "userDataDir": "./.chrome-profile",
    "headless": false
  },
  "schedule": {
    "intervalMinutes": 10,
    "jitterMinutes": 2,
    "perUrlDelaySeconds": 5,
    "holdSeconds": 15,
    "timeoutSeconds": 60,
    "loop": true
  },
  "notebooks": [
    {
      "id": "qwen-finetune",
      "name": "Qwen2.5微调环境",
      "url": "https://www.modelscope.cn/code/workspace",
      "matchPattern": "workspace",
      "action": "smart",
      "autoStart": true,
      "enabled": true
    }
  ],
  "pidFile": "keepalive.pid",
  "logFile": "keepalive.log"
}
```

#### 参数详解：

| 配置项 | 默认值 | 作用说明 |
|---|---|---|
| `browser.cdpEndpoint` | `http://127.0.0.1:9222` | Chrome 远程调试 CDP 连接地址 |
| `browser.autoLaunch` | `true` | 若 CDP 未开启，脚本是否自动拉起本地 Chrome |
| `schedule.intervalMinutes` | `10` | 保活轮询基础间隔（分钟） |
| `schedule.jitterMinutes` | `2` | 随机浮动时间（0~2 分钟），防止固定频率被识别 |
| `schedule.perUrlDelaySeconds` | `5` | 多个 Notebook 实例之间的切换等待时长（秒） |
| `notebooks[].action` | `smart` | 保活策略：`smart`（智能探测与防休眠）、`refresh`（重新载入）、`interact`（模拟活跃） |
| `notebooks[].autoStart` | `true` | 当检测到实例为停止状态时，是否自动点击“启动” |

---

## 🚀 运行模式

### 1. 启动 Chrome（若未开启远程调试）

脚本已内置自动拉起能力。如需手动拉起带调试端口的 Chrome：

**Windows**：
```cmd
npm run chrome
# 或双击 scripts/start-chrome.cmd
```

**macOS / Linux**：
```bash
node scripts/start-chrome.mjs
```

### 2. 启动保活守护进程

**前台交互运行（带终端提示与回车就绪确认）**：
```bash
npm run keepalive:loop
```

**单次执行测试（执行一轮后退出）**：
```bash
npm run keepalive
```

**后台守护进程模式（Daemon）**：
```bash
# 启动后台守护
npm run keepalive:daemon

# 查看实时日志
tail -f keepalive.log  # (或 Windows PowerShell: Get-Content keepalive.log -Wait)

# 停止守护进程
# Windows:
taskkill /F /PID $(Get-Content keepalive.pid)
# Linux/macOS:
kill $(cat keepalive.pid)
```

---

## 📱 飞书应用集成配置指南

想要在手机飞书中接收告警通知、查询状态及扫码登录，只需在飞书开放平台配置一个自建应用：

### 步骤一：创建飞书自建应用
1. 打开 [飞书开放平台开发者后台](https://open.feishu.cn/app) 并登录。
2. 点击 **“创建企业自建应用”**，填写应用名称（如 `ModelScope保活助手`）和描述，上传图标。
3. 进入 **“凭证与基础信息”**，获取 **App ID** (`cli_xxx`) 和 **App Secret**。

### 步骤二：开启机器人与事件订阅
1. 在左侧菜单点击 **“添加应用能力”** -> 选择 **“机器人”** 并开启。
2. 在左侧菜单点击 **“事件与回调”**：
   - **加密策略**：推荐选择“不加密”或配置对应 Key。
   - **事件订阅方式**：选择 **“使用长连接接收事件 (WebSocket)”**（无需配置公网请求 URL！）。
   - 添加事件：
     - `im.message.receive_v1`（接收消息）
     - `card.action.trigger`（卡片交互/按钮点击）

### 步骤三：开通权限
在左侧菜单点击 **“权限管理”**，搜索并开通以下权限：
- `im:message`（获取与发送单聊/群聊消息）
- `im:message.p2p_msg:readonly`（读取用户私聊消息）
- `im:resource:upload`（上传图片资源，用于推送登录二维码）

### 步骤四：发布版本并在飞书中使用
1. 进入 **“版本管理与发布”**，创建并发布一个新版本（可申请自用免审批）。
2. 在 `keepalive.config.json` 中配置：
   ```json
   "feishu": {
     "enabled": true,
     "appId": "cli_a1b2c3d4e5f6g7h8",
     "appSecret": "your_actual_app_secret",
     "adminUserIds": ["ou_xxxxxxxxxxxxxx"]
   }
   ```
3. 在飞书中搜索该应用机器人名称，直接私聊发送 `/help` 或 `/status` 即可开始使用！

---

## 💬 飞书指令与交互说明

| 指令 | 别名 | 功能 |
|---|---|---|
| `/status` | `状态` | 查看所有 Notebook 运行状态、健康度与上次保活时间 |
| `/refresh` | `保活` / `刷新` | 立即触发一轮全量保活检测 |
| `/login` | `重新登录` | 远程请求本地 Chrome 截图登录二维码并推送到手机飞书 |
| `/cookie <内容>` | `注入cookie` | 手机端直接发送 Cookie 字符串同步到本地浏览器 |
| `/logs` | `日志` | 查看最近的保活日志片段 |
| `/help` | `帮助` | 获取指令使用说明 |

---

## 📄 License

MIT
