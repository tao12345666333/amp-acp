#!/usr/bin/env node
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { runAcp } from './run-acp.js';

// Workaround for @ampcode/sdk: its findAmpCommand() resolves @ampcode/cli's
// pkg.bin.amp ("bin/amp.exe") and then spawns it via `node <path>`. But the
// new @ampcode/cli package replaces that stub with a native executable during
// postinstall, so `node bin/amp.exe` blows up with ERR_UNKNOWN_FILE_EXTENSION.
// Resolving the binary here and exposing it via AMP_CLI_PATH makes the SDK's
// resolveCliFromEnvironment win (and it spawns non-.js paths directly).
function preferBundledAmpCliBinary(): void {
  if (process.env.AMP_CLI_PATH) return;
  try {
    const req = createRequire(import.meta.url);
    for (const pkg of ['@ampcode/cli', '@sourcegraph/amp']) {
      try {
        const pkgJsonPath = req.resolve(`${pkg}/package.json`);
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { bin?: { amp?: string } };
        if (!pkgJson.bin?.amp) continue;
        const binPath = path.resolve(path.dirname(pkgJsonPath), pkgJson.bin.amp);
        if (!fs.existsSync(binPath)) continue;
        if (binPath.endsWith('.js') || binPath.endsWith('.mjs') || binPath.endsWith('.cjs')) continue;
        process.env.AMP_CLI_PATH = binPath;
        return;
      } catch { /* try next */ }
    }
  } catch { /* fall through; SDK will try PATH / ~/.local/share/amp */ }
}

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

  preferBundledAmpCliBinary();

  runAcp();

  process.stdin.resume();
}
