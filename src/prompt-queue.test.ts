import { beforeEach, describe, expect, it } from 'bun:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { AmpThreadMapping } from './thread-mapping-store.js';
import type { AmpExecutionOptions, AmpTransport } from './amp-transport.js';
import { AmpAcpAgent } from './server.js';

const THREAD_ID = 'T-01a03c00-e608-7007-8181-5c1cc56757be';
const MAX_QUEUED_PROMPTS = 32;

interface ControlledCall {
  options: AmpExecutionOptions;
  release: () => void;
}

function controlledTransport(): { transport: AmpTransport; calls: ControlledCall[] } {
  const calls: ControlledCall[] = [];
  const transport: AmpTransport = {
    name: 'cli',
    async *execute({ options, signal }) {
      signal.throwIfAborted();

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      calls.push({ options, release });

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

const mockClient = {
  sessionUpdate: async () => {},
} as unknown as AgentSideConnection;

const mappings = new Map<string, AmpThreadMapping>();

async function setup() {
  mappings.clear();
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

describe('AmpAcpAgent prompt queue', () => {
  beforeEach(() => {
    mappings.clear();
  });

  it('runs concurrent prompts in order and continues the same thread', async () => {
    const { agent, calls, sessionId } = await setup();

    const first = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    const second = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'second' }],
    });

    expect(calls).toHaveLength(1);
    calls[0]!.release();
    await expect(first).resolves.toEqual({ stopReason: 'end_turn' });

    await waitFor(() => calls.length === 2);
    expect(calls[1]!.options.continue).toBe(THREAD_ID);

    calls[1]!.release();
    await expect(second).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('cancels the active turn and drains queued prompts', async () => {
    const { agent, calls, sessionId } = await setup();

    const first = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    const second = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'second' }],
    });

    expect(calls).toHaveLength(1);
    await agent.cancel({ sessionId });

    await expect(first).resolves.toEqual({ stopReason: 'cancelled' });
    await expect(second).resolves.toEqual({ stopReason: 'cancelled' });
    expect(calls).toHaveLength(1);
  });

  it('does not leak cancellation into a new prompt after the queue is drained', async () => {
    const { agent, calls, sessionId } = await setup();

    const first = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    await agent.cancel({ sessionId });
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' });

    const second = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'second' }],
    });
    await waitFor(() => calls.length === 2);
    calls[1]!.release();
    await expect(second).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('rejects prompts when the queue is full', async () => {
    const { agent, calls, sessionId } = await setup();

    const first = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    const queued = Array.from({ length: MAX_QUEUED_PROMPTS }, (_, index) =>
      agent.prompt({
        sessionId,
        prompt: [{ type: 'text', text: `queued-${index}` }],
      }),
    );

    await expect(agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'overflow' }],
    })).rejects.toThrow('Prompt queue is full');

    await agent.cancel({ sessionId });
    await Promise.allSettled([first, ...queued]);
    expect(calls).toHaveLength(1);
  });
});
