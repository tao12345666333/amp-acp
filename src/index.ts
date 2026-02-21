#!/usr/bin/env node
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { runAcp } from './run-acp.js';

function getConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'amp-acp');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'amp-acp');
}

function getCredentialsPath(): string {
  return path.join(getConfigDir(), 'credentials.json');
}

function loadStoredApiKey(): string | undefined {
  const credPath = getCredentialsPath();
  try {
    const data = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as { apiKey?: string };
    return data.apiKey || undefined;
  } catch {
    return undefined;
  }
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function setup(): Promise<void> {
  const existing = process.env.AMP_API_KEY || loadStoredApiKey();
  if (existing) {
    console.error('AMP API key is already configured.');
    process.exit(0);
  }

  console.error('You can get your API key from: https://ampcode.com/settings');
  const apiKey = await prompt('Paste your AMP API key: ');
  if (!apiKey) {
    console.error('No API key provided. Aborting.');
    process.exit(1);
  }

  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });

  const credPath = getCredentialsPath();
  fs.writeFileSync(credPath, JSON.stringify({ apiKey }, null, 2) + '\n', { mode: 0o600 });

  console.error(`API key saved to ${credPath}`);
  process.exit(0);
}

if (process.argv.includes('--setup')) {
  await setup();
} else {
  if (!process.env.AMP_API_KEY) {
    const stored = loadStoredApiKey();
    if (stored) {
      process.env.AMP_API_KEY = stored;
    }
  }

  runAcp();

  process.stdin.resume();
}
