import { beforeEach, describe, expect, it } from 'bun:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { AmpThreadMapping } from './thread-mapping-store.js';
import type { AmpExecutionOptions, AmpTransport } from './amp-transport.js';
import { AmpAcpAgent } from './server.js';

const THREAD_ID = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

interface ControlledCall {
  options: AmpExecutionOptions;
  prompt: string;
  release: () => void;
}

function controlledTransport(): { transport: AmpTransport; calls: ControlledCall[] } {
  const calls: ControlledCall[] = [];
  const transport: AmpTransport = {
    name: 'cli',
    async *execute({ prompt, options, signal }) {
      signal.throwIfAborted();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      calls.push({ options, prompt, release });

      yield { type: 'system', subtype: 'init', session_id: THREAD_ID };
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        gate.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      yield { type: 'result', subtype: 'success', is_error: false };
    },
  };
  return { transport, calls };
}

const mappings = new Map<string, AmpThreadMapping>();
const notifications: Array<{ method: string; params: unknown }> = [];
const mockClient = {
  sessionUpdate: async () => {},
  notify: async (method: string, params: unknown) => {
    notifications.push({ method, params });
  },
} as unknown as AgentSideConnection;

async function setup() {
  mappings.clear();
  notifications.length = 0;
  const { transport, calls } = controlledTransport();
  const agent = new AmpAcpAgent(mockClient, transport, {
    threadStore: {
      load: async (sessionId) => mappings.get(sessionId) ?? null,
      save: async (mapping) => {
        mappings.set(mapping.sessionId, mapping);
      },
    },
    discoverPluginModes: () => [],
  });
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
  return { agent, calls, sessionId: session.sessionId };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AmpAcpAgent steer extension', () => {
  beforeEach(() => {
    mappings.clear();
    notifications.length = 0;
  });

  it('starts a new turn when the session is idle', async () => {
    const { agent, calls, sessionId } = await setup();

    const response = await agent.extMethod('_amp/session/steer', {
      sessionId,
      steerId: 'steer-1',
      prompt: [{ type: 'text', text: 'look at the failing test' }],
    });

    expect(response).toEqual({ outcome: 'startedNewTurn' });
    await waitFor(() => calls.length === 1);
    expect(notifications).toContainEqual({
      method: '_amp/session/steer_applied',
      params: { sessionId, steerId: 'steer-1' },
    });

    calls[0]!.release();
    await waitFor(() => notifications.length === 1);
  });

  it('queues a steer behind the active turn and confirms it when it starts', async () => {
    const { agent, calls, sessionId } = await setup();
    const first = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    await waitFor(() => calls.length === 1);

    const response = await agent.extMethod('_amp/session/steer', {
      sessionId,
      steerId: 'steer-2',
      prompt: [{ type: 'text', text: 'actually check the log' }],
    });

    expect(response).toEqual({ outcome: 'queued' });
    expect(notifications).toEqual([]);
    expect(calls).toHaveLength(1);

    calls[0]!.release();
    await expect(first).resolves.toEqual({ stopReason: 'end_turn' });
    await waitFor(() => calls.length === 2);
    expect(notifications).toContainEqual({
      method: '_amp/session/steer_applied',
      params: { sessionId, steerId: 'steer-2' },
    });
    expect(calls[1]!.options.continue).toBe(THREAD_ID);

    calls[1]!.release();
    await waitFor(() => calls.length === 2);
  });

  it('places a steer ahead of prompts that were already queued', async () => {
    const { agent, calls, sessionId } = await setup();
    const first = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    await waitFor(() => calls.length === 1);
    const normal = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'normal follow-up' }],
    });

    const response = await agent.extMethod('_amp/session/steer', {
      sessionId,
      steerId: 'steer-front',
      prompt: [{ type: 'text', text: 'steer this next' }],
    });

    expect(response).toEqual({ outcome: 'queued' });
    calls[0]!.release();
    await expect(first).resolves.toEqual({ stopReason: 'end_turn' });
    await waitFor(() => calls.length === 2);
    expect(calls[1]!.prompt).toContain('steer this next');

    calls[1]!.release();
    await waitFor(() => calls.length === 3);
    expect(calls[2]!.prompt).toContain('normal follow-up');
    calls[2]!.release();
    await expect(normal).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('notifies failed when cancel drops a queued steer', async () => {
    const { agent, calls, sessionId } = await setup();
    const first = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    await waitFor(() => calls.length === 1);

    await agent.extMethod('_amp/session/steer', {
      sessionId,
      steerId: 'steer-cancelled',
      prompt: [{ type: 'text', text: 'too late' }],
    });
    await agent.cancel({ sessionId });

    await expect(first).resolves.toEqual({ stopReason: 'cancelled' });
    expect(notifications).toContainEqual({
      method: '_amp/session/steer_failed',
      params: { sessionId, steerId: 'steer-cancelled', reason: 'cancelled' },
    });
  });

  it('reports failed for Orb sessions instead of silently queuing', async () => {
    const { agent, sessionId } = await setup();
    await agent.setSessionConfigOption({
      sessionId,
      configId: 'execution-environment',
      value: 'orb',
    });

    const response = await agent.extMethod('_amp/session/steer', {
      sessionId,
      steerId: 'steer-3',
      prompt: [{ type: 'text', text: 'too late' }],
    });

    expect(response).toEqual({
      outcome: 'failed',
      reason: 'Steering is only available for local sessions',
    });
  });

  it('rejects malformed steer requests', async () => {
    const { agent, sessionId } = await setup();

    await expect(agent.extMethod('_amp/session/steer', {
      sessionId,
      prompt: [{ type: 'text', text: 'missing steer id' }],
    })).rejects.toThrow('steerId must be a non-empty string');
    await expect(agent.extMethod('_amp/session/steer', {
      sessionId,
      steerId: 'steer-4',
      prompt: [],
    })).rejects.toThrow('prompt must be a non-empty array');
    await expect(agent.extMethod('_amp/session/steer', {
      sessionId,
      steerId: 'steer-bad-text',
      prompt: [{ type: 'text' }],
    })).rejects.toThrow('text prompt entries require a text string');
    await expect(agent.extMethod('_amp/session/steer', {
      sessionId,
      steerId: 'steer-bad-image',
      prompt: [{ type: 'image', mimeType: 'image/png' }],
    })).rejects.toThrow('image prompt entries require a supported mimeType');
    await expect(agent.extMethod('_amp/session/steer', undefined as never))
      .rejects.toThrow('params must be an object');
    await expect(agent.extMethod('_amp/session/steer', {
      sessionId: 'S-unknown',
      steerId: 'steer-5',
      prompt: [{ type: 'text', text: 'hello' }],
    })).rejects.toThrow('Unknown session');
  });
});
