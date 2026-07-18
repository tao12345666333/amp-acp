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
import { spawnSync } from 'node:child_process';
import { runAcp } from './run-acp.js';

const AMP_CLI_NATIVE_PACKAGES: Partial<Record<NodeJS.Platform, Partial<Record<string, { pkg: string; bin: string }>>>> = {
  darwin: {
    arm64: { pkg: '@ampcode/cli-darwin-arm64', bin: 'amp' },
    x64: { pkg: '@ampcode/cli-darwin-x64', bin: 'amp' },
  },
  linux: {
    arm64: { pkg: '@ampcode/cli-linux-arm64', bin: 'amp' },
    x64: { pkg: '@ampcode/cli-linux-x64', bin: 'amp' },
  },
  win32: {
    x64: { pkg: '@ampcode/cli-win32-x64', bin: 'amp.exe' },
  },
};

function getPlatformArch(): string {
  let arch = os.arch();
  if (process.platform === 'darwin' && arch === 'x64') {
    const result = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' });
    if (result.stdout?.trim() === '1') {
      arch = 'arm64';
    }
  }
  return arch;
}

function resolveNativeAmpCliBinary(req: ReturnType<typeof createRequire>): string | undefined {
  const nativePackage = AMP_CLI_NATIVE_PACKAGES[process.platform]?.[getPlatformArch()];
  if (!nativePackage) return undefined;

  const pkgJsonPath = req.resolve(`${nativePackage.pkg}/package.json`);
  const binPath = path.join(path.dirname(pkgJsonPath), nativePackage.bin);
  return fs.existsSync(binPath) ? binPath : undefined;
}

function isBrokenAmpCliStub(binPath: string): boolean {
  try {
    const stat = fs.statSync(binPath);
    if (stat.size >= 4096) return false;
    const contents = fs.readFileSync(binPath, 'utf8');
    return contents.includes('Amp native binary not installed') || contents.startsWith('echo ');
  } catch {
    return false;
  }
}

function repairAmpCliPackageBin(req: ReturnType<typeof createRequire>): string | undefined {
  const nativeBinPath = resolveNativeAmpCliBinary(req);
  if (!nativeBinPath) return undefined;

  const pkgJsonPath = req.resolve('@ampcode/cli/package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { bin?: { amp?: string } };
  if (!pkgJson.bin?.amp) return nativeBinPath;

  const binPath = path.resolve(path.dirname(pkgJsonPath), pkgJson.bin.amp);
  if (!fs.existsSync(binPath) || isBrokenAmpCliStub(binPath)) {
    fs.copyFileSync(nativeBinPath, binPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(binPath, 0o755);
    }
  }
  return binPath;
}

// Workaround for @ampcode/sdk / @ampcode/cli package resolution differences.
// The SDK resolves @ampcode/cli's pkg.bin.amp ("bin/amp.exe") before checking
// AMP_CLI_PATH. With Bun installs, @ampcode/cli's postinstall can be blocked,
// leaving bin/amp.exe as a tiny non-shebang placeholder shell stub. Spawning that
// path directly fails with ENOEXEC. Prefer the per-platform optional native
// package and, when needed, copy it over the placeholder so the SDK's local
// package resolver also sees a runnable binary.
function preferBundledAmpCliBinary(): void {
  if (process.env.AMP_CLI_PATH) return;
  try {
    const req = createRequire(import.meta.url);
    try {
      const ampCliBin = repairAmpCliPackageBin(req);
      if (ampCliBin) {
        process.env.AMP_CLI_PATH = ampCliBin;
        return;
      }
    } catch { /* fall back to package bin / PATH resolution */ }

    for (const pkg of ['@ampcode/cli', '@sourcegraph/amp']) {
      try {
        const pkgJsonPath = req.resolve(`${pkg}/package.json`);
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { bin?: { amp?: string } };
        if (!pkgJson.bin?.amp) continue;
        const binPath = path.resolve(path.dirname(pkgJsonPath), pkgJson.bin.amp);
        if (!fs.existsSync(binPath)) continue;
        if (pkg === '@ampcode/cli' && isBrokenAmpCliStub(binPath)) continue;
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

  if (process.env.AMP_ACP_TRANSPORT === 'sdk') {
    preferBundledAmpCliBinary();
  }

  runAcp();

  process.stdin.resume();
}
