import { describe, expect, it } from 'bun:test';
import { TurnUsage } from './turn-usage.js';

const assistant = (id: string | undefined, usage: Record<string, number>) => ({
  type: 'assistant',
  message: { id, usage },
});

describe('TurnUsage', () => {
  it('counts a response once however many messages carry it, and sums across responses', () => {
    const turn = new TurnUsage();
    // One response split over two messages, as a text block and a tool call.
    turn.add(assistant('msg_1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 }));
    turn.add(assistant('msg_1', { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 900 }));
    turn.add(assistant('msg_2', { input_tokens: 30, output_tokens: 20, cache_creation_input_tokens: 200 }));
    expect(turn.toAcp()).toEqual({
      inputTokens: 40,
      outputTokens: 60,
      cachedReadTokens: 900,
      cachedWriteTokens: 200,
      totalTokens: 1200,
    });
  });

  it('counts a response with no id as its own', () => {
    const turn = new TurnUsage();
    turn.add(assistant(undefined, { input_tokens: 1, output_tokens: 1 }));
    turn.add(assistant(undefined, { input_tokens: 2, output_tokens: 2 }));
    expect(turn.toAcp()?.totalTokens).toBe(6);
  });

  it('falls back to the result message only when no response reported usage', () => {
    const fromResult = new TurnUsage();
    fromResult.add({ type: 'result', usage: { input_tokens: 7, output_tokens: 3 } });
    expect(fromResult.toAcp()).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });

    const both = new TurnUsage();
    both.add(assistant('msg_1', { input_tokens: 1, output_tokens: 1 }));
    both.add({ type: 'result', usage: { input_tokens: 999, output_tokens: 999 } });
    expect(both.toAcp()?.totalTokens).toBe(2);
  });

  it('is null when the stream reported nothing', () => {
    const turn = new TurnUsage();
    turn.add({ type: 'system' });
    turn.add({ type: 'assistant', message: { id: 'msg_1' } });
    expect(turn.toAcp()).toBeNull();
  });
});
