import { RequestError } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { toAcpNotifications } from './to-acp.js';

export class AmpAcpAgent {
  constructor(client) {
    this.client = client;
    this.sessions = new Map();
  }

  async initialize(request) {
    this.clientCapabilities = request.clientCapabilities;
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
      },
      authMethods: [],
    };
  }

  async newSession(params) {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    this.sessions.set(sessionId, {
      proc: null,
      rl: null,
      queue: null,
      cancelled: false,
      active: false,
    });

    return {
      sessionId,
      models: { currentModelId: 'default', availableModels: [{ modelId: 'default', name: 'Default', description: 'Amp default' }] },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Always Ask', description: 'Prompts for permission on first use of each tool' },
          { id: 'acceptEdits', name: 'Accept Edits', description: 'Automatically accepts file edit permissions for the session' },
          { id: 'bypassPermissions', name: 'Bypass Permissions', description: 'Skips all permission prompts' },
          { id: 'plan', name: 'Plan Mode', description: 'Analyze but not modify files or execute commands' },
        ],
      },
    };
  }

  async authenticate(_params) {
    throw RequestError.authRequired();
  }

  async prompt(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    s.cancelled = false;
    s.active = true;

    // Start a fresh Amp process per turn (amp -x is single-turn). Avoid reusing prior proc to prevent races.
    const proc = spawn('amp', ['-x', '--stream-json', '--stream-json-input'], {
      cwd: params.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const rl = readline.createInterface({ input: proc.stdout });
    const queue = createJsonQueue(rl);
    // Capture exit to clean state
    proc.on('close', () => {
      // Do not null out queue while a turn may still await next(); just signal end
      try { queue?.end?.(); } catch {}
    });
    // Optionally log stderr (redirected to our stderr by default)
    proc.stderr?.on('data', (d) => {
      console.error(`[amp] ${d.toString()}`.trim());
    });
    s.proc = proc;
    s.rl = rl;
    s.queue = queue;
    // Don't wait for init; amp will emit it before assistant/user events

    // Build Amp user message JSON line from ACP prompt chunks
    const content = [];
    for (const chunk of params.prompt) {
      switch (chunk.type) {
        case 'text':
          content.push({ type: 'text', text: chunk.text });
          break;
        case 'resource_link':
          content.push({ type: 'text', text: chunk.uri });
          break;
        case 'resource':
          if ('text' in chunk.resource) {
            content.push({ type: 'text', text: chunk.resource.uri });
            content.push({ type: 'text', text: `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>` });
          }
          break;
        case 'image':
          if (chunk.data) {
            content.push({ type: 'image', source: { type: 'base64', data: chunk.data, media_type: chunk.mimeType } });
          } else if (chunk.uri && chunk.uri.startsWith('http')) {
            content.push({ type: 'image', source: { type: 'url', url: chunk.uri } });
          }
          break;
        default:
          break;
      }
    }

    const userMsg = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: params.sessionId,
    };

    s.proc.stdin.write(JSON.stringify(userMsg) + '\n');

    try {
      while (true) {
        const msg = await s.queue.next();
        if (msg == null) {
          return { stopReason: s.cancelled ? 'cancelled' : 'refusal' };
        }
        switch (msg.type) {
        case 'system':
          // ignore init/compact/etc
          break;
        case 'assistant': {
          const notifs = toAcpNotifications(msg, params.sessionId);
          for (const n of notifs) await this.client.sessionUpdate(n);
          break;
        }
        case 'user': {
          // Skip echoing user messages to avoid duplicates in the client UI
          break;
        }
        case 'result': {
          if (msg.subtype === 'success') return { stopReason: 'end_turn' };
          if (msg.subtype === 'error_max_turns') return { stopReason: 'max_turn_requests' };
          return { stopReason: 'refusal' };
        }
        default:
          break;
        }
      }
      throw new Error('Session did not end in result');
    } finally {
      s.active = false;
      s.cancelled = false;
    }
  }

  async cancel(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) return {};
    if (s.active && s.proc) {
      s.cancelled = true;
      try { s.proc.kill('SIGINT'); } catch {}
      // ensure readers unblock
      try { s.queue?.end?.(); } catch {}
    }
    return {};
  }

  async setSessionModel(_params) { return {}; }

  async setSessionMode(_params) { return {}; }

  async readTextFile(params) { return this.client.readTextFile(params); }
  async writeTextFile(params) { return this.client.writeTextFile(params); }
}

function createJsonQueue(rl) {
  const buf = [];
  const waiters = [];
  rl.on('line', (line) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // ignore non-JSON
    }
    if (waiters.length) {
      const resolve = waiters.shift();
      resolve(obj);
    } else {
      buf.push(obj);
    }
  });
  let ended = false;
  function end() {
    if (ended) return;
    ended = true;
    while (waiters.length) {
      const resolve = waiters.shift();
      resolve(null);
    }
  }
  rl.on('close', end);
  rl.on('SIGINT', end);
  return {
    next() {
      return new Promise((resolve) => {
        if (buf.length) {
          resolve(buf.shift());
        } else if (ended) {
          resolve(null);
        } else {
          waiters.push(resolve);
        }
      });
    },
    end,
  };
}
