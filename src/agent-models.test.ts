import { describe, expect, it } from 'bun:test';
import { discoverModels, parseShowAgentOptions } from './agent-models.js';

describe('parseShowAgentOptions', () => {
  it('parses the Models section of amp plugins show-agent-options output', () => {
    const output = `Models
  anthropic/claude-opus-5-5 (Claude Opus 5.5)
  openai/gpt-6-sol (GPT-6 Sol)

Built-in tools
  create_file
  edit_file
`;
    expect(parseShowAgentOptions(output)).toEqual([
      { modelId: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5' },
      { modelId: 'openai/gpt-6-sol', name: 'GPT-6 Sol' },
    ]);
  });

  it('stops at the first non-indented heading after Models', () => {
    const output = `Models
  openai/gpt-6-sol (GPT-6 Sol)
Something Else
  not/a-model (Nope)
`;
    expect(parseShowAgentOptions(output)).toEqual([
      { modelId: 'openai/gpt-6-sol', name: 'GPT-6 Sol' },
    ]);
  });

  it('ignores output without a Models section', () => {
    expect(parseShowAgentOptions('Built-in tools\n  create_file\n')).toEqual([]);
    expect(parseShowAgentOptions('')).toEqual([]);
  });

  it('skips malformed entry lines', () => {
    const output = `Models
  no-label-here
  (Missing id)
  openai/gpt-6-sol (GPT-6 Sol)
`;
    expect(parseShowAgentOptions(output)).toEqual([
      { modelId: 'openai/gpt-6-sol', name: 'GPT-6 Sol' },
    ]);
  });

  it('strips ANSI color codes before parsing', () => {
    const output = '\x1B[1mModels\x1B[0m\n  \x1B[36mopenai/gpt-6-sol\x1B[0m (GPT-6 Sol)\n';
    expect(parseShowAgentOptions(output)).toEqual([
      { modelId: 'openai/gpt-6-sol', name: 'GPT-6 Sol' },
    ]);
  });

  it('keeps the first occurrence of a duplicate model id', () => {
    const output = `Models
  openai/gpt-6-sol (GPT-6 Sol)
  openai/gpt-6-sol (Duplicate)
`;
    expect(parseShowAgentOptions(output)).toEqual([
      { modelId: 'openai/gpt-6-sol', name: 'GPT-6 Sol' },
    ]);
  });

  it('handles labels containing parentheses', () => {
    const output = 'Models\n  acme/model (Model (preview))\n';
    expect(parseShowAgentOptions(output)).toEqual([
      { modelId: 'acme/model', name: 'Model (preview)' },
    ]);
  });
});

describe('discoverModels', () => {
  it('returns an empty list when the CLI output is unavailable', () => {
    expect(discoverModels('/tmp', { showAgentOptions: () => null })).toEqual([]);
  });

  it('parses the overridden CLI output', () => {
    const models = discoverModels('/tmp', {
      showAgentOptions: () => 'Models\n  openai/gpt-6-sol (GPT-6 Sol)\n',
    });
    expect(models).toEqual([{ modelId: 'openai/gpt-6-sol', name: 'GPT-6 Sol' }]);
  });
});
