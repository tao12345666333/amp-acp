import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const BINARY_PATH = path.resolve(__dirname, '../dist/amp-acp-test');

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let proc: ChildProcess;
let messageQueue: JsonRpcMessage[] = [];
let nextId = 1;
let buffer = '';

function sendMessage(msg: JsonRpcMessage): void {
  proc.stdin!.write(JSON.stringify(msg) + '\n');
}

function sendRequest(method: string, params: unknown = {}): number {
  const id = nextId++;
  sendMessage({ jsonrpc: '2.0', id, method, params });
  return id;
}

function waitFor(
  predicate: (msg: JsonRpcMessage) => boolean,
  timeoutMs = 2000,
): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      const idx = messageQueue.findIndex(predicate);
      if (idx !== -1) {
        const [msg] = messageQueue.splice(idx, 1);
        resolve(msg);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function sendAndWait(
  method: string,
  params: unknown = {},
  timeoutMs = 2000,
): Promise<JsonRpcMessage> {
  const id = sendRequest(method, params);
  return waitFor((msg) => msg.id === id, timeoutMs);
}

describe('Binary integration tests', () => {
  beforeAll(() => {
    proc = spawn(BINARY_PATH, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) {
          try {
            messageQueue.push(JSON.parse(line));
          } catch {}
        }
      }
    });
  });

  afterAll(() => {
    if (proc) {
      proc.kill();
    }
  });

  it('initialize returns correct capabilities', async () => {
    const resp = await sendAndWait('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    expect(resp.result).toBeDefined();
    expect(resp.result!.protocolVersion).toBe(1);
    expect(resp.result!._meta).toBeDefined();
    expect((resp.result!._meta as Record<string, unknown>).version).toBeDefined();
    const caps = resp.result!.agentCapabilities as Record<string, Record<string, boolean>>;
    expect(caps.promptCapabilities.image).toBe(true);
    expect(caps.promptCapabilities.embeddedContext).toBe(true);
    expect(caps.mcpCapabilities.http).toBe(true);
    expect(caps.mcpCapabilities.sse).toBe(true);
    expect(resp.result!.authMethods).toEqual([]);
  });

  it('session/new returns sessionId and modes', async () => {
    const resp = await sendAndWait('session/new', {
      cwd: '/tmp/test',
      mcpServers: [],
    });

    expect(resp.result).toBeDefined();
    expect(resp.result!.sessionId).toBeDefined();
    expect(typeof resp.result!.sessionId).toBe('string');
    expect((resp.result!.sessionId as string).startsWith('S-')).toBe(true);
    const modes = resp.result!.modes as Record<string, unknown>;
    expect(modes.currentModeId).toBe('default');
    const availableModes = modes.availableModes as Array<{ id: string }>;
    expect(availableModes.map((m) => m.id)).toEqual(['default', 'bypass']);
  });

  it('session/new with MCP servers returns valid sessionId', async () => {
    const resp = await sendAndWait('session/new', {
      cwd: '/tmp/test',
      mcpServers: [
        {
          type: 'http',
          name: 'exa',
          url: 'https://mcp.exa.ai/mcp',
          headers: [],
        },
        {
          name: 'local-server',
          command: 'npx',
          args: ['mcp-server'],
          env: [],
        },
      ],
    });

    expect(resp.result).toBeDefined();
    expect((resp.result!.sessionId as string).startsWith('S-')).toBe(true);
  });

  it('session/set_mode returns empty object', async () => {
    const sessionResp = await sendAndWait('session/new', {
      cwd: '/tmp/test',
      mcpServers: [],
    });
    const sessionId = sessionResp.result!.sessionId as string;

    const resp = await sendAndWait('session/set_mode', {
      sessionId,
      modeId: 'bypass',
    });

    expect(resp.result).toEqual({});
  });

  it('authenticate returns error with code -32000', async () => {
    const resp = await sendAndWait('authenticate', {
      methodId: 'oauth',
    });

    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32000);
  });

  it('multiple sessions are independent', async () => {
    const resp1 = await sendAndWait('session/new', {
      cwd: '/tmp/a',
      mcpServers: [],
    });
    const resp2 = await sendAndWait('session/new', {
      cwd: '/tmp/b',
      mcpServers: [],
    });

    const id1 = resp1.result!.sessionId as string;
    const id2 = resp2.result!.sessionId as string;
    expect(id1).not.toBe(id2);
    expect(id1.startsWith('S-')).toBe(true);
    expect(id2.startsWith('S-')).toBe(true);
  });

  it('receives available_commands_update notification after session/new', async () => {
    const sessionResp = await sendAndWait('session/new', {
      cwd: '/tmp/notify-test',
      mcpServers: [],
    });
    const sessionId = sessionResp.result!.sessionId as string;

    const notification = await waitFor((msg) => {
      if (msg.method !== 'session/update' || !msg.params) return false;
      const params = msg.params as Record<string, unknown>;
      if (params.sessionId !== sessionId) return false;
      const update = params.update as Record<string, unknown> | undefined;
      return update?.sessionUpdate === 'available_commands_update';
    }, 2000);

    expect(notification).toBeDefined();
    expect(notification.method).toBe('session/update');
  });
});
