import type {
  SessionNotification,
  ContentBlock,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
  PlanEntry,
} from '@agentclientprotocol/sdk';

interface AmpContentText {
  type: 'text';
  text: string;
}

interface AmpContentImage {
  type: 'image';
  source?: {
    type: 'base64' | 'url';
    data?: string;
    media_type?: string;
    url?: string;
  };
}

interface AmpContentThinking {
  type: 'thinking';
  thinking: string;
}

interface AmpContentToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface AmpContentToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AmpContentText[];
  is_error: boolean;
}

type AmpContentBlock = AmpContentText | AmpContentImage | AmpContentThinking | AmpContentToolUse | AmpContentToolResult;

interface AmpMessage {
  type: string;
  message?: {
    id?: string;
    content: unknown;
  };
  session_id?: string;
}

/** Per-session conversion state shared across a streamed turn. */
export interface AcpConversionState {
  /** TodoWrite tool-call IDs whose tool results should not surface separately. */
  todoToolCallIds: Set<string>;
  /** Signature of the last emitted plan, used to suppress identical updates. */
  lastPlanSignature?: string;
}

export function createAcpConversionState(): AcpConversionState {
  return { todoToolCallIds: new Set() };
}

export function toAcpNotifications(
  message: AmpMessage,
  sessionId: string,
  state?: AcpConversionState,
): SessionNotification[] {
  const content = message.message?.content;
  if (typeof content === 'string') {
    return [
      {
        sessionId,
        update: {
          sessionUpdate: message.type === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
          content: { type: 'text', text: content } as ContentBlock,
          ...(message.message?.id ? { messageId: message.message.id } : {}),
        },
      },
    ];
  }
  const output: SessionNotification[] = [];
  if (!Array.isArray(content)) return output;
  for (const chunk of content) {
    let update: SessionNotification['update'] | null = null;
    switch (chunk.type) {
      case 'text':
        update = {
          sessionUpdate: message.type === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
          content: { type: 'text', text: chunk.text } as ContentBlock,
        };
        break;
      case 'image':
        update = {
          sessionUpdate: message.type === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
          content: {
            type: 'image',
            data: chunk.source?.type === 'base64' ? (chunk.source.data ?? '') : '',
            mimeType: chunk.source?.type === 'base64' ? (chunk.source.media_type ?? '') : '',
            uri: chunk.source?.type === 'url' ? chunk.source.url : undefined,
          } as ContentBlock,
        };
        break;
      case 'thinking':
        update = {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: chunk.thinking } as ContentBlock,
        };
        break;
      case 'tool_use':
        {
          const planEntries = chunk.name.replace(/[_\-\s]/g, '').toLowerCase() === 'todowrite'
            ? planEntriesFromTodoInput(chunk.input)
            : null;
          if (planEntries !== null) {
            state?.todoToolCallIds.add(chunk.id);
            const signature = JSON.stringify(planEntries);
            if (state?.lastPlanSignature !== signature) {
              if (state) state.lastPlanSignature = signature;
              update = {
                sessionUpdate: 'plan' as const,
                entries: planEntries,
              };
            }
          } else {
            const metadata = toolCallMetadata(chunk.name, chunk.input);
            update = {
              toolCallId: chunk.id,
              sessionUpdate: 'tool_call' as const,
              name: chunk.name,
              rawInput: safeJson(chunk.input),
              status: 'in_progress' as const,
              title: metadata.title,
              kind: metadata.kind,
              locations: metadata.locations.length > 0 ? metadata.locations : undefined,
              content: toolCallDiff(chunk.name, chunk.input),
            };
          }
        }
        break;
      case 'tool_result':
        if (!chunk.is_error && state?.todoToolCallIds.delete(chunk.tool_use_id)) {
          update = null;
        } else {
          state?.todoToolCallIds.delete(chunk.tool_use_id);
          update = {
            toolCallId: chunk.tool_use_id,
            sessionUpdate: 'tool_call_update' as const,
            status: chunk.is_error ? ('failed' as const) : ('completed' as const),
            content: toAcpContentArray(chunk.content, chunk.is_error),
            rawOutput: chunk.content,
          };
        }
        break;
      default:
        break;
    }
    if (!update) continue;
    const messageId = message.message?.id;
    if (
      messageId &&
      (update.sessionUpdate === 'user_message_chunk' ||
        update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk')
    ) {
      output.push({ sessionId, update: { ...update, messageId } });
    } else {
      output.push({ sessionId, update });
    }
  }
  return output;
}

function toAcpContentArray(content: string | AmpContentText[], isError = false): ToolCallContent[] {
  if (Array.isArray(content) && content.length > 0) {
    return content.map((c) => ({
      type: 'content' as const,
      content: { type: 'text' as const, text: isError ? wrapCode(c.text) : c.text },
    }));
  }
  if (typeof content === 'string' && content.length > 0) {
    return [{ type: 'content' as const, content: { type: 'text' as const, text: isError ? wrapCode(content) : content } }];
  }
  return [];
}

function wrapCode(t: string): string {
  return '```\n' + t + '\n```';
}

function toolCallDiff(name: string, input: unknown): ToolCallContent[] {
  const args = isRecord(input) ? input : {};
  const path = firstString(args, ['path', 'file_path']);
  if (!path) return [];

  switch (name) {
    case 'Write':
    case 'create_file': {
      const newText = optionalString(args.content) ?? optionalString(args.text);
      return newText === undefined ? [] : [{ type: 'diff', path, newText }];
    }
    case 'Edit':
    case 'edit_file': {
      const oldText = firstOptionalString(args, ['old_string', 'old_str', 'oldText']);
      const newText = firstOptionalString(args, ['new_string', 'new_str', 'newText']);
      if (newText === undefined) return [];
      return [oldText === undefined
        ? { type: 'diff', path, newText }
        : { type: 'diff', path, oldText, newText }];
    }
    case 'MultiEdit': {
      if (!Array.isArray(args.edits)) return [];
      const diffs: ToolCallContent[] = [];
      for (const edit of args.edits) {
        if (!isRecord(edit)) continue;
        const oldText = firstOptionalString(edit, ['old_string', 'old_str', 'oldText']);
        const newText = firstOptionalString(edit, ['new_string', 'new_str', 'newText']);
        if (newText === undefined) continue;
        diffs.push(oldText === undefined
          ? { type: 'diff', path, newText }
          : { type: 'diff', path, oldText, newText });
      }
      return diffs;
    }
    default:
      return [];
  }
}

interface ToolCallMetadata {
  title: string;
  kind: ToolKind;
  locations: ToolCallLocation[];
}

function planEntriesFromTodoInput(input: unknown): PlanEntry[] | null {
  if (!isRecord(input) || !Array.isArray(input.todos)) return null;
  const entries: PlanEntry[] = [];
  for (const value of input.todos) {
    if (!isRecord(value)) continue;
    const content = stringValue(value.content)?.trim();
    if (!content) continue;
    const status = value.status === 'in_progress' || value.status === 'completed'
      ? value.status
      : 'pending';
    const priority = value.priority === 'high' || value.priority === 'low'
      ? value.priority
      : 'medium';
    entries.push({ content, priority, status });
  }
  return entries;
}

function toolCallMetadata(name: string, input: unknown): ToolCallMetadata {
  const toolName = name || 'Tool';
  const args = isRecord(input) ? input : {};
  const title = toolCallTitle(toolName, args);

  return {
    title,
    kind: toolKind(toolName),
    locations: toolCallLocations(toolName, args),
  };
}

function toolCallTitle(name: string, input: Record<string, unknown>): string {
  const command = commandValue(input);
  const path = firstString(input, ['path', 'file_path', 'notebook_path']);
  const pattern = stringValue(input.pattern);
  const url = stringValue(input.url);

  switch (name) {
    case 'Bash':
    case 'shell_command':
    case 'code_exec':
      return withDetail(name, command);
    case 'Read':
    case 'read_file':
    case 'Write':
    case 'create_file':
    case 'Edit':
    case 'edit_file':
    case 'MultiEdit':
    case 'delete_file':
    case 'apply_patch':
      return withDetail(name, path);
    case 'Glob':
    case 'Grep':
      return withDetail(name, pattern ?? path);
    case 'LS':
      return withDetail('List', path);
    case 'WebFetch':
      return withDetail(name, url);
    case 'TodoWrite':
    case 'todo_write':
      return 'Update todo list';
    case 'Task':
      return withDetail(name, stringValue(input.description) ?? stringValue(input.subagent_type));
    default:
      return withDetail(name, firstScalarString(input));
  }
}

function commandValue(input: Record<string, unknown>): string | undefined {
  return (
    commandSegmentValue(input.cmd) ??
    commandSegmentValue(input.command) ??
    firstString(input, ['shell_command', 'shellCommand', 'script']) ??
    nestedCommandValue(input, 0)
  );
}

function commandSegmentValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function nestedCommandValue(value: unknown, depth: number): string | undefined {
  if (!isRecord(value) || depth > 2) return undefined;
  const direct = commandSegmentValue(value.cmd) ?? commandSegmentValue(value.command);
  if (direct) return direct;

  for (const child of Object.values(value)) {
    if (!isRecord(child)) continue;
    const nested = nestedCommandValue(child, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function toolKind(name: string): ToolKind {
  switch (name) {
    case 'Read':
    case 'read_file':
    case 'LS':
      return 'read';
    case 'Write':
    case 'create_file':
    case 'Edit':
    case 'edit_file':
    case 'MultiEdit':
    case 'delete_file':
    case 'apply_patch':
      return 'edit';
    case 'Glob':
    case 'Grep':
      return 'search';
    case 'Bash':
    case 'shell_command':
    case 'code_exec':
      return 'execute';
    case 'WebFetch':
      return 'fetch';
    case 'TodoWrite':
    case 'todo_write':
    case 'Task':
      return 'think';
    default:
      return name.startsWith('mcp__') ? 'fetch' : 'other';
  }
}

function toolCallLocations(name: string, input: Record<string, unknown>): ToolCallLocation[] {
  const path = firstString(input, ['path', 'file_path', 'notebook_path']);
  if (!path) return [];

  switch (name) {
    case 'Read':
    case 'read_file':
    case 'Write':
    case 'create_file':
    case 'Edit':
    case 'edit_file':
    case 'MultiEdit':
    case 'delete_file':
    case 'apply_patch':
    case 'LS':
    case 'Grep':
    case 'Glob': {
      const line = numberValue(input.line) ?? numberValue(input.offset);
      return line === undefined ? [{ path }] : [{ path, line }];
    }
    default:
      return [];
  }
}

function withDetail(name: string, detail: string | undefined): string {
  if (!detail) return name;
  return `${name}: ${truncateSingleLine(detail, 120)}`;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(input[key]);
    if (value) return value;
  }
  return undefined;
}

function firstOptionalString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = optionalString(input[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function firstScalarString(input: Record<string, unknown>): string | undefined {
  for (const value of Object.values(input)) {
    const string = stringValue(value) ?? numberValue(value)?.toString() ?? booleanValue(value)?.toString();
    if (string) return string;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(x: unknown): { [k: string]: unknown } | undefined {
  try {
    return JSON.parse(JSON.stringify(x)) as { [k: string]: unknown };
  } catch {
    return undefined;
  }
}
