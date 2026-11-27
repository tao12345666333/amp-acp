import { describe, expect, it } from 'bun:test';
import { discoverModels, parseShowAgentOptions } from './agent-models.js';

describe('parseShowAgentOptions', () => {
  it('parses the models array from amp plugins show-agent-options --json', () => {
    const output = JSON.stringify({
      models: [
        {
          id: 'anthropic/claude-opus-5-5',
          name: 'claude-opus-5-5',
          displayName: 'Claude Opus 5.5',
          capabilities: { reasoning: true, efforts: ['low', 'high', 'max'] },
        },
        { id: 'openai/gpt-6-sol', name: 'gpt-6-sol', displayName: 'GPT-6 Sol' },
        { id: 'acme/no-reasoning', displayName: 'No Reasoning', capabilities: { reasoning: false } },
      ],
      tools: [{ id: 'create_file' }],
    });
    expect(parseShowAgentOptions(output)).toEqual([
      { modelId: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'high', 'max'] },
      { modelId: 'openai/gpt-6-sol', name: 'GPT-6 Sol' },
      { modelId: 'acme/no-reasoning', name: 'No Reasoning', efforts: [] },
    ]);
  });

  it('falls back to name and then the model id when displayName is missing', () => {
    const output = JSON.stringify({
      models: [
        { id: 'acme/model-a', name: 'Model A' },
        { id: 'acme/model-b' },
      ],
    });
    expect(parseShowAgentOptions(output)).toEqual([
      { modelId: 'acme/model-a', name: 'Model A' },
      { modelId: 'acme/model-b', name: 'acme/model-b' },
    ]);
  });

  it('accepts a top-level models array', () => {
    expect(parseShowAgentOptions(JSON.stringify([
      { id: 'acme/model', displayName: 'Model' },
    ]))).toEqual([{ modelId: 'acme/model', name: 'Model' }]);
  });

  it('ignores malformed entries and non-string ids', () => {
    const output = JSON.stringify({
      models: [
        null,
        'not-an-object',
        { displayName: 'Missing id' },
        { id: 42, displayName: 'Numeric id' },
        { id: '  acme/model  ', displayName: '  Model  ' },
      ],
    });
    expect(parseShowAgentOptions(output)).toEqual([
      { modelId: 'acme/model', name: 'Model' },
    ]);
  });

  it('keeps the first occurrence of a duplicate model id', () => {
    const output = JSON.stringify({
      models: [
        { id: 'acme/model', displayName: 'First' },
        { id: 'acme/model', displayName: 'Duplicate' },
      ],
    });
    expect(parseShowAgentOptions(output)).toEqual([
      { modelId: 'acme/model', name: 'First' },
    ]);
  });

  it('returns an empty list for malformed or unexpected output', () => {
    expect(parseShowAgentOptions('')).toEqual([]);
    expect(parseShowAgentOptions('Models\n  acme/model (Model)\n')).toEqual([]);
    expect(parseShowAgentOptions('{"models": "not-an-array"}')).toEqual([]);
    expect(parseShowAgentOptions('{"tools": []}')).toEqual([]);
  });
});

describe('discoverModels', () => {
  it('returns an empty list when the CLI output is unavailable', () => {
    expect(discoverModels('/tmp', { showAgentOptions: () => null })).toEqual([]);
  });

  it('parses the overridden CLI output', () => {
    const models = discoverModels('/tmp', {
      showAgentOptions: () => JSON.stringify({
        models: [{ id: 'openai/gpt-6-sol', displayName: 'GPT-6 Sol' }],
      }),
    });
    expect(models).toEqual([{ modelId: 'openai/gpt-6-sol', name: 'GPT-6 Sol' }]);
  });
});
