import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_CONFIG = {
  feishu: {
    enabled: false,
    appId: '',
    appSecret: '',
    botName: 'ModelScope保活助手',
    receiveMode: 'websocket',
    notifyOnSuccessIntervalRounds: 6,
    notifyOnFailure: true,
    adminUserIds: [],
  },
  browser: {
    cdpEndpoint: 'http://127.0.0.1:9222',
    autoLaunch: true,
    browserPath: '',
    userDataDir: './.chrome-profile',
    headless: false,
  },
  schedule: {
    intervalMinutes: 10,
    jitterMinutes: 2,
    perUrlDelaySeconds: 5,
    holdSeconds: 15,
    timeoutSeconds: 60,
    loop: false,
  },
  notebooks: [
    {
      id: 'modelscope-main',
      name: 'ModelScope工作空间',
      url: 'https://www.modelscope.cn/code/workspace',
      action: 'smart',
      autoStart: true,
      enabled: true,
    },
  ],
  webServer: {
    port: 3000,
    publicUrl: '',
  },
  gemini: {
    enabled: true,
    apiKey: '',
    model: 'gemini-3.7-flash',
    effort: 'high',
    proxy: 'http://192.168.0.110:31028',
    timeoutMs: 180000,
  },
  loginProvider: 'csdn',
  pidFile: '',
  logFile: '',
};

export function parseArgs(argv) {
  const parsed = {};
  const urls = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.indexOf('=');
    const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;

    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${name}`);
      return argv[index];
    };

    switch (name) {
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '--config':
        parsed.configPath = value();
        break;
      case '--loop':
        parsed.loop = true;
        break;
      case '--once':
        parsed.loop = false;
        break;
      case '--interval-minutes':
        parsed.intervalMinutes = Number(value());
        break;
      case '--jitter-minutes':
        parsed.jitterMinutes = Number(value());
        break;
      case '--hold-seconds':
        parsed.holdSeconds = Number(value());
        break;
      case '--timeout-seconds':
        parsed.timeoutSeconds = Number(value());
        break;
      case '--cdp':
      case '--cdp-endpoint':
        parsed.cdpEndpoint = value();
        break;
      case '--url':
        urls.push(value());
        break;
      case '--pid-file':
        parsed.pidFile = value();
        break;
      case '--log-file':
        parsed.logFile = value();
        break;
      default:
        // Ignore or store unknown flag
        break;
    }
  }

  if (urls.length > 0) {
    parsed.overrideUrls = urls;
  }

  return parsed;
}

export async function loadConfig(customConfigPath, cliArgs = {}) {
  const configFilePath = customConfigPath || cliArgs.configPath || process.env.KEEPALIVE_CONFIG || 'keepalive.config.json';
  const resolvedPath = resolve(process.cwd(), configFilePath);
  let fileConfig = {};

  let targetPath = resolvedPath;
  if (!existsSync(targetPath)) {
    const examplePath = resolve(process.cwd(), 'keepalive.config.example.json');
    if (existsSync(examplePath)) {
      targetPath = examplePath;
    }
  }

  if (existsSync(targetPath)) {
    try {
      const content = await readFile(targetPath, 'utf8');
      fileConfig = JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse config at ${targetPath}: ${err.message}`);
    }
  }

  // Deep merge default config with file config
  const merged = {
    feishu: {
      ...DEFAULT_CONFIG.feishu,
      ...(fileConfig.feishu || {}),
    },
    browser: {
      ...DEFAULT_CONFIG.browser,
      ...(fileConfig.browser || {}),
    },
    schedule: {
      ...DEFAULT_CONFIG.schedule,
      ...(fileConfig.schedule || {}),
    },
    webServer: {
      ...DEFAULT_CONFIG.webServer,
      ...(fileConfig.webServer || {}),
    },
    gemini: {
      ...DEFAULT_CONFIG.gemini,
      ...(fileConfig.gemini || {}),
    },
    notebooks: Array.isArray(fileConfig.notebooks) && fileConfig.notebooks.length > 0
      ? fileConfig.notebooks
      : (fileConfig.urls && Array.isArray(fileConfig.urls)
          ? fileConfig.urls.map((url, i) => ({ id: `nb-${i + 1}`, name: `Notebook-${i + 1}`, url, action: 'smart', autoStart: true, enabled: true }))
          : DEFAULT_CONFIG.notebooks),
    loginProvider: fileConfig.loginProvider || DEFAULT_CONFIG.loginProvider || 'csdn',
    pidFile: fileConfig.pidFile || DEFAULT_CONFIG.pidFile,
    logFile: fileConfig.logFile || DEFAULT_CONFIG.logFile,
  };

  // Apply CLI overrides
  if (cliArgs.loop !== undefined) merged.schedule.loop = cliArgs.loop;
  if (cliArgs.intervalMinutes !== undefined && !isNaN(cliArgs.intervalMinutes)) merged.schedule.intervalMinutes = cliArgs.intervalMinutes;
  if (cliArgs.jitterMinutes !== undefined && !isNaN(cliArgs.jitterMinutes)) merged.schedule.jitterMinutes = cliArgs.jitterMinutes;
  if (cliArgs.holdSeconds !== undefined && !isNaN(cliArgs.holdSeconds)) merged.schedule.holdSeconds = cliArgs.holdSeconds;
  if (cliArgs.timeoutSeconds !== undefined && !isNaN(cliArgs.timeoutSeconds)) merged.schedule.timeoutSeconds = cliArgs.timeoutSeconds;
  if (cliArgs.cdpEndpoint) merged.browser.cdpEndpoint = cliArgs.cdpEndpoint;
  if (cliArgs.pidFile) merged.pidFile = cliArgs.pidFile;
  if (cliArgs.logFile) merged.logFile = cliArgs.logFile;

  if (cliArgs.overrideUrls && cliArgs.overrideUrls.length > 0) {
    merged.notebooks = cliArgs.overrideUrls.map((url, idx) => ({
      id: `cli-nb-${idx + 1}`,
      name: `CLI-Notebook-${idx + 1}`,
      url,
      action: 'smart',
      autoStart: true,
      enabled: true,
    }));
  }

  // Ensure notebooks list is valid
  merged.notebooks = merged.notebooks.filter(nb => nb && nb.url && nb.enabled !== false);
  if (merged.notebooks.length === 0) {
    merged.notebooks = [...DEFAULT_CONFIG.notebooks];
  }

  return { config: merged, configPath: resolvedPath };
}
