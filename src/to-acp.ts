import type { SessionNotification, ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk';

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
    content: string | AmpContentBlock[];
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
        update = {
          toolCallId: chunk.id,
          sessionUpdate: 'tool_call' as const,
          rawInput: safeJson(chunk.input),
          status: 'pending' as const,
          title: chunk.name || 'Tool',
          kind: 'other' as const,
          content: [],
        };
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

function safeJson(x: unknown): { [k: string]: unknown } | undefined {
  try {
    return JSON.parse(JSON.stringify(x)) as { [k: string]: unknown };
  } catch {
    return undefined;
  }
}
