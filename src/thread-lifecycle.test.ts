import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { AmpExecutionRequest, AmpTransport } from './amp-transport.js';
import { AmpAcpAgent } from './server.js';
import { FileThreadMappingStore } from './thread-mapping-store.js';

const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

const client = {
  sessionUpdate: async () => {},
  readTextFile: async () => ({ text: '' }),
  writeTextFile: async () => ({}),
  requestPermission: async () => ({ optionId: '' }),
  createTerminal: async () => ({ id: '' }),
  extMethod: async () => ({}),
  extNotification: async () => {},
} as unknown as AgentSideConnection;

function transportWithThread(requests: AmpExecutionRequest[]): AmpTransport {
  return {
    name: 'cli',
    execute(request) {
      requests.push(request);
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: threadId };
        yield { type: 'result', subtype: 'success', is_error: false };
      })();
    },
  };
}

describe('Amp ACP thread lifecycle extension', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-lifecycle-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('exposes and persists the streamed Amp thread ID separately from the ACP session ID', async () => {
    const requests: AmpExecutionRequest[] = [];
    const store = new FileThreadMappingStore(stateDir);
    const agent = new AmpAcpAgent(client, transportWithThread(requests), { threadStore: store });
    const initialized = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp/project', mcpServers: [] });

    expect(initialized.agentCapabilities?._meta?.['amp-acp/thread-lifecycle']).toEqual({
      version: 1,
      methods: {
        nativeMetadata: 'amp-acp/session/native-metadata',
        setArchived: 'amp-acp/thread/set-archived',
      },
    });
    expect(await agent.extMethod('amp-acp/session/native-metadata', {
      sessionId: session.sessionId,
    })).toEqual({ version: 1, sessionId: session.sessionId, ampThreadId: null });

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(session.sessionId).toMatch(/^S-/);
    expect(await agent.extMethod('amp-acp/session/native-metadata', {
      sessionId: session.sessionId,
    })).toEqual({ version: 1, sessionId: session.sessionId, ampThreadId: threadId });
    expect((await store.load(session.sessionId))?.threadId).toBe(threadId);
  });

  it('resumes the exact persisted Amp thread after an adapter restart', async () => {
    const store = new FileThreadMappingStore(stateDir);
    await store.save({
      sessionId: 'S-mrestart-abcdef',
      threadId,
    });
    const requests: AmpExecutionRequest[] = [];
    const restartedAgent = new AmpAcpAgent(client, transportWithThread(requests), { threadStore: store });

    await restartedAgent.resumeSession({
      sessionId: 'S-mrestart-abcdef',
      cwd: '/tmp/original',
      mcpServers: [],
    });
    await restartedAgent.prompt({
      sessionId: 'S-mrestart-abcdef',
      prompt: [{ type: 'text', text: 'continue' }],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.options.continue).toBe(threadId);
  });

  it('archives and unarchives only when both IDs match the persisted mapping', async () => {
    const store = new FileThreadMappingStore(stateDir);
    const sessionId = 'S-marchive-abcdef';
    await store.save({ sessionId, threadId });
    const operations: Array<{ threadId: string; archived: boolean }> = [];
    const agent = new AmpAcpAgent(client, transportWithThread([]), {
      threadStore: store,
      setThreadArchived: async (targetThreadId, archived) => {
        operations.push({ threadId: targetThreadId, archived });
      },
    });

    expect(await agent.extMethod('amp-acp/thread/set-archived', {
      sessionId,
      threadId,
      archived: true,
    })).toEqual({ version: 1, threadId, archived: true });
    expect(await agent.extMethod('amp-acp/thread/set-archived', {
      sessionId,
      threadId,
      archived: false,
    })).toEqual({ version: 1, threadId, archived: false });
    expect(operations).toEqual([
      { threadId, archived: true },
      { threadId, archived: false },
    ]);

    await expect(agent.extMethod('amp-acp/thread/set-archived', {
      sessionId,
      threadId: 'T-11a03c00-e608-7007-8181-5c1cc56757be',
      archived: true,
    })).rejects.toThrow('does not match');
    expect(operations).toHaveLength(2);
  });

  it('does not archive a legacy ACP session with no durable mapping', async () => {
    const operations: string[] = [];
    const agent = new AmpAcpAgent(client, transportWithThread([]), {
      threadStore: new FileThreadMappingStore(stateDir),
      setThreadArchived: async (targetThreadId) => {
        operations.push(targetThreadId);
      },
    });

    await expect(agent.extMethod('amp-acp/thread/set-archived', {
      sessionId: 'S-mlegacy-abcdef',
      threadId,
      archived: true,
    })).rejects.toThrow('No durable Amp thread mapping');
    expect(operations).toEqual([]);
  });
});
