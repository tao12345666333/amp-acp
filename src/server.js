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

    // Start a fresh Amp process per turn. Amp does not expose the Claude Code JSON stream flags;
    // we pipe plain text and stream stdout lines back to ACP.
    const ampCmd = process.env.AMP_EXECUTABLE || 'amp';
    const spawnEnv = { ...process.env };
    if (process.env.AMP_PREFER_SYSTEM_PATH === '1' && spawnEnv.PATH) {
      // Drop npx/npm-local node_modules/.bin segments so we pick the system 'amp'
      const parts = spawnEnv.PATH.split(':').filter((p) => !/\bnode_modules\/\.bin\b|\/_npx\//.test(p));
      spawnEnv.PATH = parts.join(':');
    }
    const proc = spawn(ampCmd, ['--no-notifications'], {
      cwd: params.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
    });

    const rlOut = readline.createInterface({ input: proc.stdout });
    const rlErr = readline.createInterface({ input: proc.stderr });

    s.proc = proc;
    s.rl = rlOut;
    s.queue = null;

    let hadOutput = false;

    rlOut.on('line', async (line) => {
      hadOutput = true;
      if (!line) return;
      try {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: line },
          },
        });
      } catch (e) {
        console.error('[acp] sessionUpdate failed', e);
      }
    });

    rlErr.on('line', (line) => {
      console.error(`[amp] ${line}`);
    });

    // Build plain-text input for Amp from ACP prompt chunks
    let textInput = '';
    for (const chunk of params.prompt) {
      switch (chunk.type) {
        case 'text':
          textInput += chunk.text;
          break;
        case 'resource_link':
          textInput += `\n${chunk.uri}\n`;
          break;
        case 'resource':
          if ('text' in chunk.resource) {
            textInput += `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>\n`;
          }
          break;
        case 'image':
          // Images not supported by Amp CLI via stdin; ignore for now
          break;
        default:
          break;
      }
    }
    if (!textInput.endsWith('\n')) textInput += '\n';

    proc.stdin.write(textInput);
    proc.stdin.end();

    try {
      await new Promise((resolve) => {
        proc.on('close', () => {
          try { rlOut.close(); } catch {}
          try { rlErr.close(); } catch {}
          resolve();
        });
      });
      return { stopReason: s.cancelled ? 'cancelled' : (hadOutput ? 'end_turn' : 'refusal') };
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
