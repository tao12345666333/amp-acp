import { describe, expect, it } from 'bun:test';
import { createAcpConversionState, toAcpNotifications } from './to-acp.js';

const sessionId = 'S-test-abcdef';

function todoMessage(todos: unknown[], id = 'todo-1', name = 'TodoWrite') {
  return {
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id,
        name,
        input: { todos },
      }],
    },
  };
}

describe('TodoWrite to ACP plan', () => {
  it('maps the full todo list with statuses and priorities', () => {
    const notifications = toAcpNotifications(todoMessage([
      { content: 'Inspect the parser', status: 'in_progress', priority: 'high' },
      { content: 'Add tests', status: 'pending' },
      { content: 'Ship it', status: 'completed', priority: 'low' },
    ]), sessionId, createAcpConversionState());

    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.update).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect the parser', status: 'in_progress', priority: 'high' },
        { content: 'Add tests', status: 'pending', priority: 'medium' },
        { content: 'Ship it', status: 'completed', priority: 'low' },
      ],
    });
  });

  it('recognizes Amp snake_case todo_write tool calls', () => {
    const notifications = toAcpNotifications(
      todoMessage([{ content: 'Inspect the parser', status: 'pending' }], 'todo-1', 'todo_write'),
      sessionId,
      createAcpConversionState(),
    );

    expect(notifications[0]!.update).toMatchObject({ sessionUpdate: 'plan' });
  });

  it('emits an empty plan when the todo list is cleared', () => {
    const notifications = toAcpNotifications(
      todoMessage([], 'todo-1', 'todo_write'),
      sessionId,
      createAcpConversionState(),
    );

    expect(notifications[0]!.update).toEqual({ sessionUpdate: 'plan', entries: [] });
  });

  it('surfaces a failed todo tool result instead of suppressing it', () => {
    const state = createAcpConversionState();
    toAcpNotifications(todoMessage([{ content: 'One', status: 'pending' }], 'todo-1'), sessionId, state);

    const failed = toAcpNotifications({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'todo-1',
          content: 'permission denied',
          is_error: true,
        }],
      },
    }, sessionId, state);

    expect(failed[0]!.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      status: 'failed',
    });
  });

  it('treats unknown statuses as pending and skips empty content', () => {
    const notifications = toAcpNotifications(todoMessage([
      { content: 'Do the thing', status: 'blocked' },
      { content: '   ', status: 'pending' },
    ]), sessionId, createAcpConversionState());

    expect(notifications[0]!.update).toEqual({
      sessionUpdate: 'plan',
      entries: [{ content: 'Do the thing', status: 'pending', priority: 'medium' }],
    });
  });

  it('replaces the whole plan and suppresses identical updates', () => {
    const state = createAcpConversionState();
    const first = toAcpNotifications(todoMessage([
      { content: 'One', status: 'in_progress' },
      { content: 'Two', status: 'pending' },
    ]), sessionId, state);
    const duplicate = toAcpNotifications(todoMessage([
      { content: 'One', status: 'in_progress' },
      { content: 'Two', status: 'pending' },
    ], 'todo-2'), sessionId, state);
    const changed = toAcpNotifications(todoMessage([
      { content: 'One', status: 'completed' },
      { content: 'Two', status: 'in_progress' },
    ], 'todo-3'), sessionId, state);

    expect(first).toHaveLength(1);
    expect(duplicate).toEqual([]);
    expect(changed[0]!.update).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'One', status: 'completed', priority: 'medium' },
        { content: 'Two', status: 'in_progress', priority: 'medium' },
      ],
    });
  });

  it('suppresses the TodoWrite tool result but keeps other tool results', () => {
    const state = createAcpConversionState();
    toAcpNotifications(todoMessage([{ content: 'One', status: 'pending' }], 'todo-1'), sessionId, state);

    const todoResult = toAcpNotifications({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'todo-1', content: 'Todos updated' }],
      },
    }, sessionId, state);
    const otherResult = toAcpNotifications({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'other-1', content: 'ok' }],
      },
    }, sessionId, state);

    expect(todoResult).toEqual([]);
    expect(otherResult[0]!.update.sessionUpdate).toBe('tool_call_update');
  });

  it('falls back to a tool call when the todo list is malformed', () => {
    const notifications = toAcpNotifications({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'todo-1', name: 'TodoWrite', input: { todos: 'nope' } }],
      },
    }, sessionId, createAcpConversionState());

    expect(notifications[0]!.update.sessionUpdate).toBe('tool_call');
  });
});
