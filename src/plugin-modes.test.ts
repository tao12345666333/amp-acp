import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAgentModeComments,
  parseAmpPluginsList,
  readAmpPluginsList,
  clearPluginListCache,
  scanPluginDir,
  getSystemPluginDir,
  discoverPluginModes,
} from './plugin-modes.js';

const GROK45_SOURCE = `// @amp-agent-mode {"key":"grok45","label":"Grok 4.5"}

import type { PluginAPI } from '@ampcode/plugin'

export default function (amp: PluginAPI) {
  amp.registerAgentMode({
    key: 'grok45',
    label: 'Grok 4.5',
    agent: { ... },
  })
}
`;

const KIMI_SOURCE = `// @amp-agent-mode {"key":"kimi-k3","label":"Kimi K3"}
export default function () {}
`;

const WORKSPACE_PLUGIN_LIST = `✓ factory-local (User Plugins) active
  tool: factory_local_task
✓ official-modes (Workspace Plugins) active
  agent: grok-4-5
  agent mode: grok45
  agent mode: grok46
  agent mode: kimi-k3
✓ inactive-modes (Workspace Plugins) disabled
  agent mode: should-not-appear
`;

describe('parseAgentModeComments', () => {
  it('parses a single @amp-agent-mode comment', () => {
    expect(parseAgentModeComments(GROK45_SOURCE)).toEqual([
      { modelId: 'grok45', name: 'Grok 4.5' },
    ]);
  });

  it('parses multiple comments in one file', () => {
    expect(parseAgentModeComments(`${GROK45_SOURCE}\n${KIMI_SOURCE}`)).toEqual([
      { modelId: 'grok45', name: 'Grok 4.5' },
      { modelId: 'kimi-k3', name: 'Kimi K3' },
    ]);
  });

  it('returns nothing for a file without the comment', () => {
    expect(parseAgentModeComments('export default function () {}')).toEqual([]);
  });

  it('ignores malformed JSON comments', () => {
    const source = '// @amp-agent-mode {not json}\nexport default function () {}';
    expect(parseAgentModeComments(source)).toEqual([]);
  });

  it('ignores comments missing key or label', () => {
    expect(parseAgentModeComments('// @amp-agent-mode {"key":"nope"}')).toEqual([]);
    expect(parseAgentModeComments('// @amp-agent-mode {"label":"Nope"}')).toEqual([]);
    expect(parseAgentModeComments('// @amp-agent-mode {"key":"","label":""}')).toEqual([]);
  });

  it('does not match unrelated comments', () => {
    expect(parseAgentModeComments('// amp-agent-mode {"key":"x","label":"X"}')).toEqual([]);
  });
});

describe('parseAmpPluginsList', () => {
  it('extracts agent modes from active Workspace/Personal plugins', () => {
    expect(parseAmpPluginsList(WORKSPACE_PLUGIN_LIST)).toEqual([
      { modelId: 'grok45', name: 'grok45', source: 'official-modes' },
      { modelId: 'grok46', name: 'grok46', source: 'official-modes' },
      { modelId: 'kimi-k3', name: 'kimi-k3', source: 'official-modes' },
    ]);
  });

  it('ignores agent: lines that are not selectable modes', () => {
    const output = '✓ official-modes (Workspace Plugins) active\n  agent: grok-4-5\n';
    expect(parseAmpPluginsList(output)).toEqual([]);
  });

  it('returns nothing for empty or unrelated output', () => {
    expect(parseAmpPluginsList('')).toEqual([]);
    expect(parseAmpPluginsList('✓ factory-local (User Plugins) active\n  tool: factory_local_task\n')).toEqual([]);
  });

  it('strips ANSI color codes from CLI output', () => {
    const output = '\x1B[32m✓\x1B[0m official-modes (Workspace Plugins) active\n  agent mode: grok45\n';
    expect(parseAmpPluginsList(output)).toEqual([
      { modelId: 'grok45', name: 'grok45', source: 'official-modes' },
    ]);
  });

  it('deduplicates agent mode keys case-insensitively', () => {
    const output = `✓ official-modes (Workspace Plugins) active
  agent mode: grok45
  agent mode: Grok45
`;
    expect(parseAmpPluginsList(output)).toEqual([
      { modelId: 'grok45', name: 'grok45', source: 'official-modes' },
    ]);
  });
});

describe('scanPluginDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'amp-acp-plugins-'));
    writeFileSync(path.join(dir, 'grok-45-mode.ts'), GROK45_SOURCE);
    writeFileSync(path.join(dir, 'task.js'), '// no agent mode here');
    writeFileSync(path.join(dir, 'readme.txt'), GROK45_SOURCE);
    mkdirSync(path.join(dir, 'subdir'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers modes from .ts/.js plugin files and records the source file', () => {
    expect(scanPluginDir(dir)).toEqual([
      { modelId: 'grok45', name: 'Grok 4.5', source: 'grok-45-mode.ts' },
    ]);
  });

  it('discovers modes from a directory plugin index.ts', () => {
    const pluginDir = path.join(dir, 'official-modes');
    mkdirSync(pluginDir);
    writeFileSync(path.join(pluginDir, 'index.ts'), GROK45_SOURCE);
    expect(scanPluginDir(dir)).toContainEqual(
      { modelId: 'grok45', name: 'Grok 4.5', source: 'official-modes' },
    );
  });

  it('returns an empty list for a missing directory', () => {
    expect(scanPluginDir(path.join(dir, 'does-not-exist'))).toEqual([]);
  });
});

describe('discoverPluginModes', () => {
  const originalEnv = process.env.AMP_ACP_SYSTEM_PLUGIN_DIR;
  const originalDisable = process.env.AMP_ACP_DISABLE_PLUGIN_LIST;
  let systemDir: string;
  let projectDir: string;

  beforeEach(() => {
    systemDir = mkdtempSync(path.join(os.tmpdir(), 'amp-acp-system-'));
    projectDir = mkdtempSync(path.join(os.tmpdir(), 'amp-acp-project-'));
    process.env.AMP_ACP_SYSTEM_PLUGIN_DIR = systemDir;
    process.env.AMP_ACP_DISABLE_PLUGIN_LIST = '1';
  });

  afterEach(() => {
    rmSync(systemDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.AMP_ACP_SYSTEM_PLUGIN_DIR;
    } else {
      process.env.AMP_ACP_SYSTEM_PLUGIN_DIR = originalEnv;
    }
    if (originalDisable === undefined) {
      delete process.env.AMP_ACP_DISABLE_PLUGIN_LIST;
    } else {
      process.env.AMP_ACP_DISABLE_PLUGIN_LIST = originalDisable;
    }
  });

  it('discovers modes from the system plugin dir', () => {
    writeFileSync(path.join(systemDir, 'grok-45-mode.ts'), GROK45_SOURCE);
    expect(discoverPluginModes(projectDir)).toEqual([
      { modelId: 'grok45', name: 'Grok 4.5', source: 'grok-45-mode.ts' },
    ]);
  });

  it('discovers modes from the project .amp/plugins dir', () => {
    const pluginsDir = path.join(projectDir, '.amp', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(path.join(pluginsDir, 'kimi-k3-mode.ts'), KIMI_SOURCE);
    expect(discoverPluginModes(projectDir)).toEqual([
      { modelId: 'kimi-k3', name: 'Kimi K3', source: 'kimi-k3-mode.ts' },
    ]);
  });

  it('prefers the project plugin when both declare the same mode key', () => {
    writeFileSync(path.join(systemDir, 'grok-45-mode.ts'), GROK45_SOURCE);
    const pluginsDir = path.join(projectDir, '.amp', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      path.join(pluginsDir, 'grok45.ts'),
      '// @amp-agent-mode {"key":"grok45","label":"Project Grok"}\nexport default function () {}',
    );
    expect(discoverPluginModes(projectDir)).toEqual([
      { modelId: 'grok45', name: 'Project Grok', source: 'grok45.ts' },
    ]);
  });

  it('discovers Workspace plugin modes from amp plugins list', () => {
    expect(discoverPluginModes(projectDir, {
      listPlugins: () => WORKSPACE_PLUGIN_LIST,
    })).toEqual([
      { modelId: 'grok45', name: 'grok45', source: 'official-modes' },
      { modelId: 'grok46', name: 'grok46', source: 'official-modes' },
      { modelId: 'kimi-k3', name: 'kimi-k3', source: 'official-modes' },
    ]);
  });

  it('deduplicates project vs CLI keys case-insensitively and keeps the local declaration', () => {
    const pluginsDir = path.join(projectDir, '.amp', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      path.join(pluginsDir, 'grok.ts'),
      '// @amp-agent-mode {"key":"Grok45","label":"Project Grok"}\nexport default function () {}',
    );
    expect(discoverPluginModes(projectDir, {
      listPlugins: () => WORKSPACE_PLUGIN_LIST,
    })).toEqual([
      { modelId: 'Grok45', name: 'Project Grok', source: 'grok.ts' },
      { modelId: 'grok46', name: 'grok46', source: 'official-modes' },
      { modelId: 'kimi-k3', name: 'kimi-k3', source: 'official-modes' },
    ]);
  });

  it('keeps the local label when amp plugins list reports the same key', () => {
    writeFileSync(path.join(systemDir, 'grok-45-mode.ts'), GROK45_SOURCE);
    expect(discoverPluginModes(projectDir, {
      listPlugins: () => WORKSPACE_PLUGIN_LIST,
    })).toEqual([
      { modelId: 'grok45', name: 'Grok 4.5', source: 'grok-45-mode.ts' },
      { modelId: 'grok46', name: 'grok46', source: 'official-modes' },
      { modelId: 'kimi-k3', name: 'kimi-k3', source: 'official-modes' },
    ]);
  });

  it('returns built-ins only when no plugins are installed', () => {
    expect(discoverPluginModes(projectDir, { listPlugins: () => null })).toEqual([]);
  });

  it('skips amp plugins list when AMP_ACP_DISABLE_PLUGIN_LIST=1', () => {
    expect(readAmpPluginsList(projectDir)).toBeNull();
  });

  it('discovers Workspace modes from a fake amp plugins list binary', () => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), 'amp-acp-cli-'));
    const ampPath = path.join(binDir, 'amp');
    writeFileSync(
      ampPath,
      `#!${process.execPath}
if (process.argv[2] === 'plugins' && process.argv[3] === 'list') {
  process.stdout.write('✓ official-modes (Workspace Plugins) active\\n  agent mode: grok45\\n');
  process.exit(0);
}
process.exit(1);
`,
    );
    chmodSync(ampPath, 0o755);

    const originalCli = process.env.AMP_CLI_PATH;
    delete process.env.AMP_ACP_DISABLE_PLUGIN_LIST;
    process.env.AMP_CLI_PATH = ampPath;
    clearPluginListCache();
    try {
      expect(discoverPluginModes(projectDir)).toEqual([
        { modelId: 'grok45', name: 'grok45', source: 'official-modes' },
      ]);
    } finally {
      if (originalCli === undefined) {
        delete process.env.AMP_CLI_PATH;
      } else {
        process.env.AMP_CLI_PATH = originalCli;
      }
      clearPluginListCache();
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('caches a successful amp plugins list spawn per cwd', () => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), 'amp-acp-cli-cache-'));
    const ampPath = path.join(binDir, 'amp');
    const counterPath = path.join(binDir, 'count');
    writeFileSync(counterPath, '0');
    writeFileSync(
      ampPath,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const counterPath = ${JSON.stringify(counterPath)};
if (process.argv[2] === 'plugins' && process.argv[3] === 'list') {
  const n = Number(readFileSync(counterPath, 'utf8')) + 1;
  writeFileSync(counterPath, String(n));
  process.stdout.write('✓ official-modes (Workspace Plugins) active\\n  agent mode: grok45\\n');
  process.exit(0);
}
process.exit(1);
`,
    );
    chmodSync(ampPath, 0o755);

    const originalCli = process.env.AMP_CLI_PATH;
    delete process.env.AMP_ACP_DISABLE_PLUGIN_LIST;
    process.env.AMP_CLI_PATH = ampPath;
    clearPluginListCache();
    try {
      expect(readAmpPluginsList(projectDir)).toContain('grok45');
      expect(readAmpPluginsList(projectDir)).toContain('grok45');
      expect(readFileSync(counterPath, 'utf8')).toBe('1');
    } finally {
      if (originalCli === undefined) {
        delete process.env.AMP_CLI_PATH;
      } else {
        process.env.AMP_CLI_PATH = originalCli;
      }
      clearPluginListCache();
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('getSystemPluginDir', () => {
  const originalEnv = process.env.AMP_ACP_SYSTEM_PLUGIN_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AMP_ACP_SYSTEM_PLUGIN_DIR;
    } else {
      process.env.AMP_ACP_SYSTEM_PLUGIN_DIR = originalEnv;
    }
  });

  it('honors AMP_ACP_SYSTEM_PLUGIN_DIR when set', () => {
    process.env.AMP_ACP_SYSTEM_PLUGIN_DIR = '/tmp/custom-plugins';
    expect(getSystemPluginDir()).toBe('/tmp/custom-plugins');
  });

  it('defaults to ~/.config/amp/plugins', () => {
    delete process.env.AMP_ACP_SYSTEM_PLUGIN_DIR;
    expect(getSystemPluginDir()).toBe(
      path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
        'amp',
        'plugins',
      ),
    );
  });
});
