// Minimal conversion from Amp stream JSON events (Claude Code compatible)
// into ACP sessionUpdate notifications. Based on zed-industries/claude-code-acp.

export function toAcpNotifications(message, sessionId) {
  const content = message.message?.content;
  if (typeof content === 'string') {
    return [
      {
        sessionId,
        update: {
          sessionUpdate: message.type === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
          content: { type: 'text', text: content },
        },
      },
    ];
  }
  const output = [];
  if (!Array.isArray(content)) return output;
  for (const chunk of content) {
    let update = null;
    switch (chunk.type) {
      case 'text':
        update = {
          sessionUpdate: message.type === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
          content: { type: 'text', text: chunk.text },
        };
        break;
      case 'image':
        update = {
          sessionUpdate: message.type === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
          content: {
            type: 'image',
            data: chunk.source?.type === 'base64' ? chunk.source.data : '',
            mimeType: chunk.source?.type === 'base64' ? chunk.source.media_type : '',
            uri: chunk.source?.type === 'url' ? chunk.source.url : undefined,
          },
        };
        break;
      case 'thinking':
        update = {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: chunk.thinking },
        };
        break;
      case 'tool_use':
        update = {
          toolCallId: chunk.id,
          sessionUpdate: 'tool_call',
          rawInput: safeJson(chunk.input),
          status: 'pending',
          title: chunk.name || 'Tool',
          kind: 'other',
          content: [],
        };
        break;
      case 'tool_result':
        update = {
          toolCallId: chunk.tool_use_id,
          sessionUpdate: 'tool_call_update',
          status: chunk.is_error ? 'failed' : 'completed',
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

function toAcpContentArray(content, isError = false) {
  if (Array.isArray(content) && content.length > 0) {
    return content.map((c) => ({
      type: 'content',
      content: c.type === 'text' ? { type: 'text', text: isError ? wrapCode(c.text) : c.text } : c,
    }));
  }
  if (typeof content === 'string' && content.length > 0) {
    return [{ type: 'content', content: { type: 'text', text: isError ? wrapCode(content) : content } }];
  }
  return [];
}

function wrapCode(t) {
  return '```\n' + t + '\n```';
}

function safeJson(x) {
  try { return JSON.parse(JSON.stringify(x)); } catch { return undefined; }
}