import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAgentModeComments,
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

  it('returns an empty list for a missing directory', () => {
    expect(scanPluginDir(path.join(dir, 'does-not-exist'))).toEqual([]);
  });
});

describe('discoverPluginModes', () => {
  const originalEnv = process.env.AMP_ACP_SYSTEM_PLUGIN_DIR;
  let systemDir: string;
  let projectDir: string;

  beforeEach(() => {
    systemDir = mkdtempSync(path.join(os.tmpdir(), 'amp-acp-system-'));
    projectDir = mkdtempSync(path.join(os.tmpdir(), 'amp-acp-project-'));
    process.env.AMP_ACP_SYSTEM_PLUGIN_DIR = systemDir;
  });

  afterEach(() => {
    rmSync(systemDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.AMP_ACP_SYSTEM_PLUGIN_DIR;
    } else {
      process.env.AMP_ACP_SYSTEM_PLUGIN_DIR = originalEnv;
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

  it('prefers the system plugin when both declare the same mode key', () => {
    writeFileSync(path.join(systemDir, 'grok-45-mode.ts'), GROK45_SOURCE);
    const pluginsDir = path.join(projectDir, '.amp', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      path.join(pluginsDir, 'grok45.ts'),
      '// @amp-agent-mode {"key":"grok45","label":"Project Grok"}\nexport default function () {}',
    );
    expect(discoverPluginModes(projectDir)).toEqual([
      { modelId: 'grok45', name: 'Grok 4.5', source: 'grok-45-mode.ts' },
    ]);
  });

  it('returns built-ins only when no plugins are installed', () => {
    expect(discoverPluginModes(projectDir)).toEqual([]);
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
    expect(getSystemPluginDir()).toBe(path.join(os.homedir(), '.config', 'amp', 'plugins'));
  });
});
