import { describe, expect, it } from 'bun:test';
import { toAcpNotifications } from './to-acp.js';

function toolCall(name: string, input: unknown, id = 'tool-1') {
  return toAcpNotifications(
    {
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id, name, input }],
      },
    },
    'session-1',
  );
}

describe('toAcpNotifications tool details', () => {
  it('reports the tool name, raw input, and in-progress status', () => {
    const [notification] = toolCall('Read', { path: '/tmp/file.txt' });

    expect(notification!.update).toMatchObject({
      sessionUpdate: 'tool_call',
      name: 'Read',
      status: 'in_progress',
      rawInput: { path: '/tmp/file.txt' },
    });
  });

  it('includes the raw tool output on completion', () => {
    const [notification] = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'exit code 1', is_error: false }],
        },
      },
      'session-1',
    );

    expect(notification!.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      rawOutput: 'exit code 1',
    });
  });

  it('renders a new-file diff for Write', () => {
    const [notification] = toolCall('Write', { path: '/tmp/new.ts', content: 'export const x = 1;' });

    expect(notification!.update).toMatchObject({
      sessionUpdate: 'tool_call',
      content: [{ type: 'diff', path: '/tmp/new.ts', newText: 'export const x = 1;' }],
    });
    const update = notification!.update as { content?: Array<Record<string, unknown>> };
    expect(update.content?.[0]).not.toHaveProperty('oldText');
  });

  it('renders diffs that create or delete empty content', () => {
    const [created] = toolCall('create_file', { path: '/tmp/empty.ts', content: '' });
    expect(created!.update).toMatchObject({
      content: [{ type: 'diff', path: '/tmp/empty.ts', newText: '' }],
    });

    const [deleted] = toolCall('edit_file', {
      path: '/tmp/app.ts',
      old_string: 'remove me\n',
      new_string: '',
    });
    expect(deleted!.update).toMatchObject({
      content: [{ type: 'diff', path: '/tmp/app.ts', oldText: 'remove me\n', newText: '' }],
    });
  });

  it('maps Amp file and shell tool names to kinds and locations', () => {
    const [file] = toolCall('create_file', { path: '/tmp/new.ts', content: 'x' });
    expect(file!.update).toMatchObject({
      title: 'create_file: /tmp/new.ts',
      kind: 'edit',
      locations: [{ path: '/tmp/new.ts' }],
    });

    const [shell] = toolCall('shell_command', { command: 'bun test' });
    expect(shell!.update).toMatchObject({ kind: 'execute' });
  });

  it('renders an edit diff for Edit', () => {
    const [notification] = toolCall('Edit', {
      path: '/tmp/app.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    });

    expect(notification!.update).toMatchObject({
      sessionUpdate: 'tool_call',
      content: [{
        type: 'diff',
        path: '/tmp/app.ts',
        oldText: 'const a = 1;',
        newText: 'const a = 2;',
      }],
    });
  });

  it('renders one diff per MultiEdit entry', () => {
    const [notification] = toolCall('MultiEdit', {
      path: '/tmp/app.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    });

    expect(notification!.update).toMatchObject({
      content: [
        { type: 'diff', path: '/tmp/app.ts', oldText: 'a', newText: 'b' },
        { type: 'diff', path: '/tmp/app.ts', oldText: 'c', newText: 'd' },
      ],
    });
  });

  it('omits diffs when the input lacks a path or replacement text', () => {
    for (const [name, input] of [
      ['Edit', { old_string: 'a', new_string: 'b' }],
      ['Write', { path: '/tmp/file.ts' }],
      ['Edit', { path: '/tmp/file.ts' }],
    ] as const) {
      const [notification] = toolCall(name, input);
      expect(notification!.update).toMatchObject({ content: [] });
    }
  });

  it('propagates the Amp message ID to content chunks', () => {
    const result = toAcpNotifications(
      {
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [
            { type: 'thinking', thinking: 'checking' },
            { type: 'text', text: 'done' },
          ],
        },
      },
      'session-1',
    );

    expect(result).toHaveLength(2);
    for (const notification of result) {
      expect(notification.update).toMatchObject({ messageId: 'msg-1' });
    }
  });
});
