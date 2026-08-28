#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { platform, homedir } from 'node:os';

const PORT = process.env.CHROME_REMOTE_DEBUG_PORT || '9222';
const PROFILE_DIR = resolve(process.cwd(), process.env.CHROME_USER_DATA_DIR || '.chrome-profile');

if (!existsSync(PROFILE_DIR)) {
  mkdirSync(PROFILE_DIR, { recursive: true });
}

function findChromeExecutable() {
  const os = platform();
  if (os === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } else if (os === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } else {
    // Linux
    const candidates = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
    return candidates[0];
  }
  return null;
}

export function launchChrome(customPath) {
  const executable = customPath || findChromeExecutable();
  if (!executable) {
    console.error('[CHROME] Chrome or Edge executable not found. Please install Chrome or specify path in config.');
    return null;
  }

  console.log(`[CHROME] Launching Chrome with remote debugging on port ${PORT}...`);
  console.log(`[CHROME] Executable: ${executable}`);
  console.log(`[CHROME] Profile directory: ${PROFILE_DIR}`);

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://www.modelscope.cn/code/workspace',
  ];

  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
  console.log(`[CHROME] Browser process started in background.`);
  return child;
}

if (process.argv[1] && process.argv[1].endsWith('start-chrome.mjs')) {
  launchChrome();
}
