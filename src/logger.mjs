import { createWriteStream } from 'node:fs';

let logStream = null;
const recentLogs = [];
const MAX_RECENT_LOGS = 100;

export function timestamp() {
  return new Date().toISOString();
}

export function initLogger(logFilePath) {
  if (logFilePath) {
    try {
      logStream = createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
    } catch (err) {
      console.error(`[${timestamp()}] [LOGGER] Failed to open log file ${logFilePath}: ${err.message}`);
    }
  }
}

export function closeLogger() {
  if (logStream) {
    try {
      logStream.end();
    } catch {
      // ignore
    }
    logStream = null;
  }
}

function appendRecent(line) {
  recentLogs.push(line);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.shift();
  }
}

export function getRecentLogs(limit = 20) {
  return recentLogs.slice(-Math.min(limit, recentLogs.length));
}

export function log(level, message, ...args) {
  const ts = timestamp();
  const extra = args.length > 0 ? ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') : '';
  const line = `[${ts}] [${level.toUpperCase()}] ${message}${extra}`;

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }

  appendRecent(line);

  if (logStream) {
    try {
      logStream.write(line + '\n');
    } catch {
      // ignore write error
    }
  }
}

export const logger = {
  info: (msg, ...args) => log('info', msg, ...args),
  warn: (msg, ...args) => log('warn', msg, ...args),
  error: (msg, ...args) => log('error', msg, ...args),
  success: (msg, ...args) => log('success', msg, ...args),
  cdp: (msg, ...args) => log('cdp', msg, ...args),
  feishu: (msg, ...args) => log('feishu', msg, ...args),
  engine: (msg, ...args) => log('engine', msg, ...args),
  getRecentLogs,
  initLogger,
  closeLogger,
};

export default logger;
