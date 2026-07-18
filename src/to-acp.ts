import type {
  SessionNotification,
  ContentBlock,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
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
    content: unknown;
  };
  session_id?: string;
}

export function toAcpNotifications(message: AmpMessage, sessionId: string): SessionNotification[] {
  const content = message.message?.content;
  if (typeof content === 'string') {
    return [
      {
        sessionId,
        update: {
          sessionUpdate: message.type === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
          content: { type: 'text', text: content } as ContentBlock,
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
          const metadata = toolCallMetadata(chunk.name, chunk.input);
          update = {
            toolCallId: chunk.id,
            sessionUpdate: 'tool_call' as const,
            rawInput: safeJson(chunk.input),
            status: 'pending' as const,
            title: metadata.title,
            kind: metadata.kind,
            locations: metadata.locations.length > 0 ? metadata.locations : undefined,
            content: [],
          };
        }
        break;
      case 'tool_result':
        update = {
          toolCallId: chunk.tool_use_id,
          sessionUpdate: 'tool_call_update' as const,
          status: chunk.is_error ? ('failed' as const) : ('completed' as const),
          content: toAcpContentArray(chunk.content, chunk.is_error),
        };
        break;
      default:
        break;
    }
    if (update) output.push({ sessionId, update });
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

interface ToolCallMetadata {
  title: string;
  kind: ToolKind;
  locations: ToolCallLocation[];
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
      return withDetail(name, command);
    case 'Read':
      return withDetail(name, path);
    case 'Write':
      return withDetail(name, path);
    case 'Edit':
    case 'MultiEdit':
      return withDetail(name, path);
    case 'Glob':
      return withDetail(name, pattern ?? path);
    case 'Grep':
      return withDetail(name, pattern ?? path);
    case 'LS':
      return withDetail('List', path);
    case 'WebFetch':
      return withDetail(name, url);
    case 'TodoWrite':
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
    case 'LS':
      return 'read';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return 'edit';
    case 'Glob':
    case 'Grep':
      return 'search';
    case 'Bash':
      return 'execute';
    case 'WebFetch':
      return 'fetch';
    case 'TodoWrite':
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
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
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
