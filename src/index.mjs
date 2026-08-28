#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import process from 'node:process';

import logger, { initLogger, closeLogger } from './logger.mjs';
import { parseArgs, loadConfig } from './config.mjs';
import { BrowserManager } from './cdp/browser-manager.mjs';
import { AuthDetector } from './cdp/auth-detector.mjs';
import { Scheduler } from './engine/scheduler.mjs';
import { stateStore } from './engine/state-store.mjs';
import { FeishuNotifier } from './feishu/notifier.mjs';
import { MessageHandler } from './feishu/message-handler.mjs';
import { FeishuWSClient } from './feishu/ws-client.mjs';
import { H5Server } from './server/h5-server.mjs';

let shuttingDown = false;

// ── PID management ────────────────────────────────────────────────────────────

async function writePidFile(pidFile) {
  if (!pidFile) return;
  try {
    await writeFile(pidFile, String(process.pid), 'utf8');
    logger.info(`PID ${process.pid} written to ${pidFile}`);
  } catch (err) {
    logger.warn(`Failed to write PID file: ${err.message}`);
  }
}

async function removePidFile(pidFile) {
  if (!pidFile || !existsSync(pidFile)) return;
  try {
    await unlink(pidFile);
  } catch {
    // ignore
  }
}

// ── Signal Handling ───────────────────────────────────────────────────────────

function setupSignals(cleanupFn) {
  const handleSignal = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, gracefully shutting down...`);
    await cleanupFn();
    process.exit(0);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}

// ── Terminal Prompt for Login ──────────────────────────────────────────────────

async function promptUserLoginIfRequired(browserManager, notifier) {
  try {
    const page = await browserManager.getPrimaryPage();
    const status = await AuthDetector.checkLoginStatus(page);

    if (status.loggedIn) {
      logger.success('ModelScope session is already logged in.');
      return;
    }

    logger.warn(`ModelScope is not logged in (${status.reason || 'Session not detected'}).`);

    if (process.stdin.isTTY) {
      console.log('\n' + '='.repeat(70));
      console.log(' [ModelScope Keepalive] 请在打开的浏览器中完成登录并进入 Notebook 页面...');
      console.log(' 完成后请在当前终端按 [Enter] 键继续保活循环...');
      console.log('='.repeat(70) + '\n');

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question('按 [Enter] 确认已完成登录: ');
      rl.close();
    } else {
      logger.info('Non-interactive environment detected. Triggering Feishu notification if available...');
      if (notifier.enabled) {
        const qrResult = await AuthDetector.captureLoginQRCode(page);
        if (qrResult.buffer) {
          await notifier.sendLoginQRCode(qrResult.buffer);
        }
      }
    }
  } catch (err) {
    logger.warn(`Login prompt inspection notice: ${err.message}`);
  }
}

// ── Main Entry ────────────────────────────────────────────────────────────────

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (cliArgs.help) {
    console.log(`
ModelScope Notebook Keepalive Daemon (modellive)

Usage:
  node src/index.mjs [options]
  npm run keepalive
  npm run keepalive:loop
  npm run keepalive:daemon

Options:
  --config <path>             Path to keepalive.config.json
  --loop                      Run continuously with interval + jitter
  --once                      Run a single round then exit
  --interval-minutes <num>    Loop interval in minutes (default: 10)
  --jitter-minutes <num>      Random delay in minutes (default: 2)
  --cdp <endpoint>            Chrome CDP endpoint (default: http://127.0.0.1:9222)
  --url <url>                 Override notebook URL
  --pid-file <path>           Write process PID to file
  --log-file <path>           Append timestamped logs to file
  -h, --help                  Show help
`);
    return;
  }

  const { config, configPath } = await loadConfig(cliArgs.configPath, cliArgs);
  initLogger(config.logFile);

  logger.info(`Starting ModelScope Keepalive Daemon (Config: ${configPath})`);
  logger.info(`Configured Notebooks: ${config.notebooks.length}`);
  logger.info(`Timing: Interval=${config.schedule.intervalMinutes}m, Jitter=${config.schedule.jitterMinutes}m, Hold=${config.schedule.holdSeconds}s`);

  await writePidFile(config.pidFile);

  // Initialize Browser & CDP
  const browserManager = new BrowserManager(config);
  await browserManager.connect();

  // Initialize Feishu components
  const notifier = new FeishuNotifier(config);

  // Setup Scheduler
  const scheduler = new Scheduler(browserManager, config);

  const messageHandler = new MessageHandler({
    notifier,
    scheduler,
    browserManager,
  });

  const wsClient = new FeishuWSClient(config, messageHandler);
  if (config.feishu?.enabled) {
    await wsClient.start();
  }

  // Initialize H5 Interactive Slider Web Server
  const h5Server = new H5Server({
    port: config.webServer?.port || 3000,
    publicUrl: config.webServer?.publicUrl || '',
    browserManager,
    scheduler,
    notifier,
  });
  await h5Server.start();
  notifier.h5Url = h5Server.getUrl();

  // Hook scheduler events to Feishu Notifier
  const successInterval = config.feishu?.notifyOnSuccessIntervalRounds || 6;
  scheduler.on('roundComplete', async (summary) => {
    if (notifier.enabled) {
      const nonCaptchaFailed = summary.results.filter(r => !r.ok && r.error !== 'Captcha verification required');
      if (nonCaptchaFailed.length > 0) {
        await notifier.sendAlert(
          '保活轮询异常告警',
          `第 #${summary.roundNumber} 轮保活完成，共 ${summary.total} 个实例，成功 ${summary.succeeded} 个，失败 ${summary.failed} 个。`,
          nonCaptchaFailed.map(r => `${r.id}: ${r.error}`).join('\n')
        );
      } else if (summary.roundNumber % successInterval === 0 && summary.failed === 0) {
        await notifier.sendStatus(summary.summary);
      }
    }
  });

  scheduler.on('loginExpired', async ({ notebook, reason, page }) => {
    if (notifier.enabled) {
      logger.warn(`Triggering Feishu login QR code notification for ${notebook.name}...`);
      const qrResult = await AuthDetector.captureLoginQRCode(page, config.loginProvider || 'csdn');
      if (qrResult.buffer) {
        await notifier.sendLoginQRCode(qrResult.buffer, null, qrResult.providerUsed);
      } else {
        await notifier.sendAlert('ModelScope 登录态已失效', `实例 [${notebook.name}] 访问失败：${reason || '未登录'}，请前往电脑端完成登录。`);
      }
    }
  });

  scheduler.on('instanceStarted', async ({ notebook }) => {
    if (notifier.enabled) {
      logger.success(`[${notebook.name}] Notifying Feishu: Instance is active and protected!`);
      await notifier.sendText(
        `🎉 **ModelScope 实例已在云端启动成功！**\n\n🟢 实例【${notebook.name}】当前处于 **Running** 运行状态。\n💻 PC 守护进程已自动无缝接管 **24/7 全自动保活**，您无需再保持手机页面！`
      );
    }
  });

  scheduler.on('instanceDisconnected', async ({ notebook }) => {
    if (notifier.enabled) {
      logger.warn(`[${notebook.name}] Instance disconnected in cloud, sending Launch Card to Feishu...`);
      await notifier.sendLaunchPrompt(notebook.name, notebook.url || 'https://www.modelscope.cn/code/workspace');
    }
  });

  scheduler.on('captchaRequired', async ({ notebook, buffer }) => {
    h5Server.setCaptchaBuffer(buffer);
    if (notifier.enabled) {
      logger.warn(`[${notebook.name}] Pushing captcha verification card to Feishu...`);
      await notifier.sendCaptchaCard(
        buffer,
        null,
        `实例【${notebook.name}】在连接时触发了图片滑块验证`,
        h5Server.getUrl()
      );
    }
  });

  // Setup graceful cleanup
  setupSignals(async () => {
    scheduler.stop();
    await h5Server.stop();
    await wsClient.stop();
    await browserManager.disconnect();
    await removePidFile(config.pidFile);
    closeLogger();
  });

  // Check login prompt on startup
  await promptUserLoginIfRequired(browserManager, notifier);

  // Execute rounds
  if (config.schedule.loop) {
    await scheduler.startLoop();
  } else {
    logger.info('Executing single keepalive round (--once mode)...');
    const result = await scheduler.runRound();
    if (result.failed > 0) {
      process.exitCode = 1;
    }
    await browserManager.disconnect();
    await removePidFile(config.pidFile);
    closeLogger();
  }
}

main().catch(async (err) => {
  logger.error(`Fatal application error: ${err.message}\n${err.stack}`);
  closeLogger();
  process.exit(1);
});
