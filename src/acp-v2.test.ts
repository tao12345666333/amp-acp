import { describe, expect, test } from 'bun:test';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { toAcpV2Update } from './acp-v2.js';

describe('toAcpV2Update', () => {
  test('translates v1 plan into a v2 plan_update', () => {
    const update = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect the repo', priority: 'high', status: 'completed' },
        { content: 'Add the adapter', priority: 'medium', status: 'in_progress' },
      ],
    } as SessionUpdate;

    expect(toAcpV2Update(update)).toEqual({
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items',
        planId: 'amp-plan',
        entries: [
          { content: 'Inspect the repo', priority: 'high', status: 'completed' },
          { content: 'Add the adapter', priority: 'medium', status: 'in_progress' },
        ],
      },
    });
  });

  test('translates v1 tool_call into a v2 tool_call_update', () => {
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Edit README.md',
      kind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: '/tmp/README.md', newText: 'hello' }],
      rawInput: { path: '/tmp/README.md' },
    } as SessionUpdate;

    expect(toAcpV2Update(update)).toEqual({
      ...update,
      sessionUpdate: 'tool_call_update',
    });
  });

  test('passes through updates shared by both protocol versions', () => {
    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    } as SessionUpdate;

    expect(toAcpV2Update(update)).toBe(update);
  });
});
