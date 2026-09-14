import { describe, expect, it } from 'bun:test';
import {
  BUILTIN_AMP_MODES,
  createAmpModeCatalog,
  parsePluginAgentModes,
} from './amp-modes.js';

describe('parsePluginAgentModes', () => {
  it('extracts agent mode keys from `amp plugins list` output', () => {
    const output = [
      'Plugins:',
      '  baseten-modes (~/.config/amp/plugins/baseten-modes.ts)',
      '    agent mode: bt-glm-5-3-flash',
      '    agent mode: bt-kimi-k3',
      '  official-modes (.amp/plugins/official-modes.ts)',
      '    agent: reviewer',
      '    agent mode: acp-flash',
      '    tool: something',
      'agent mode: no-leading-whitespace',
    ].join('\n');

    expect(parsePluginAgentModes(output)).toEqual([
      'bt-glm-5-3-flash',
      'bt-kimi-k3',
      'acp-flash',
      'no-leading-whitespace',
    ]);
  });

  it('dedupes keys and ignores malformed lines', () => {
    const output = [
      '  agent mode: acp-flash',
      '  agent mode: acp-flash',
      '  agent mode:',
      '  agent modes: plural-does-not-match',
      'not an agent mode line',
    ].join('\n');

    expect(parsePluginAgentModes(output)).toEqual(['acp-flash']);
  });

  it('returns an empty list when no plugin modes exist', () => {
    expect(parsePluginAgentModes('Plugins:\n  none')).toEqual([]);
  });
});

describe('createAmpModeCatalog', () => {
  it('combines built-in modes with discovered plugin modes', async () => {
    const catalog = createAmpModeCatalog({
      listPluginsOutput: async () => '  agent mode: acp-flash\n  agent mode: acp-flash\n',
    });

    const modes = await catalog('/tmp/project');
    expect(modes.map((mode) => mode.value)).toEqual([
      'low',
      'medium',
      'high',
      'ultra',
      'acp-flash',
    ]);
    expect(modes.find((mode) => mode.value === 'acp-flash')).toEqual({
      value: 'acp-flash',
      name: 'acp-flash',
      description: 'Custom agent mode from an Amp plugin.',
    });
  });

  it('falls back to built-in modes when discovery fails', async () => {
    const catalog = createAmpModeCatalog({
      listPluginsOutput: async () => {
        throw new Error('amp CLI not found');
      },
    });

    expect(await catalog('/tmp/project')).toEqual(BUILTIN_AMP_MODES);
  });

  it('caches discovery per working directory', async () => {
    let calls = 0;
    const catalog = createAmpModeCatalog({
      listPluginsOutput: async () => {
        calls += 1;
        return '  agent mode: acp-flash\n';
      },
    });

    await catalog('/tmp/a');
    await catalog('/tmp/a');
    await catalog('/tmp/b');

    expect(calls).toBe(2);
  });

  it('discovers modes through the real spawn path', async () => {
    const catalog = createAmpModeCatalog({
      command: process.execPath,
      commandArgs: ['-e', 'console.log("  agent mode: acp-flash")'],
    });

    const modes = await catalog('/tmp');
    expect(modes.map((mode) => mode.value)).toContain('acp-flash');
  });

  it('falls back to built-in modes when the command fails', async () => {
    const catalog = createAmpModeCatalog({
      command: '/definitely/not/a/real/amp-binary',
    });

    expect(await catalog('/tmp')).toEqual(BUILTIN_AMP_MODES);
  });
});
