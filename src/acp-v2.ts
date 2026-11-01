import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  type AgentApp,
  type AgentConnection,
  agent,
} from '@agentclientprotocol/sdk/experimental/v2';
import type * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import type {
  AgentSideConnection,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import packageJson from '../package.json';
import { AmpAcpAgent } from './server.js';

const PACKAGE_VERSION: string = packageJson.version;
const PLAN_ID = 'amp-plan';

function toAcpV2ConfigOptions(
  options: NewSessionResponse['configOptions'],
): v2.NewSessionResponse['configOptions'] {
  return options?.map((option) => {
    const { id, ...rest } = option;
    return { ...rest, configId: id } as unknown as v2.SessionConfigOption;
  });
}

function toV1McpServers(
  servers: v2.NewSessionRequest['mcpServers'],
): NewSessionRequest['mcpServers'] | undefined {
  return servers?.map((server) => {
    if (server.type === 'stdio') {
      return {
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
      } as unknown as NewSessionRequest['mcpServers'][number];
    }
    return server as unknown as NewSessionRequest['mcpServers'][number];
  });
}

/**
 * Translates ACP v1 session updates into the v2 shapes that changed. Updates
 * that are already shared between both protocol versions pass through.
 */
export function toAcpV2Update(update: SessionUpdate): v2.SessionUpdate {
  switch (update.sessionUpdate) {
    case 'tool_call':
      return {
        ...update,
        sessionUpdate: 'tool_call_update',
      } as unknown as v2.SessionUpdate;
    case 'plan':
      return {
        sessionUpdate: 'plan_update',
        plan: {
          type: 'items',
          planId: PLAN_ID,
          entries: update.entries,
        },
      } as unknown as v2.SessionUpdate;
    default:
      return update as unknown as v2.SessionUpdate;
  }
}

function textFromPrompt(prompt: PromptRequest['prompt']): string {
  return prompt
    .filter((block): block is Extract<PromptRequest['prompt'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function messageIdFor(sessionId: string): string {
  return `M-${sessionId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface V1ClientLike {
  sessionUpdate(notification: SessionNotification): Promise<void>;
  requestPermission(params: unknown): Promise<unknown>;
  readTextFile(params: unknown): Promise<unknown>;
  writeTextFile(params: unknown): Promise<unknown>;
}

/**
 * Experimental ACP v2 adapter. The session, model, prompt queue, cancellation,
 * and Amp transport behavior stay in the v1 `AmpAcpAgent`; this class translates
 * v2 wire requests into those calls and translates the resulting v1 updates
 * back to v2.
 *
 * Enabled with `AMP_ACP_PROTOCOL=v2`; the default entry point keeps using the
 * v1 `AgentSideConnection` so existing clients are unaffected.
 */
export class AcpV2Adapter {
  private readonly app: AgentApp;
  private connection?: AgentConnection;
  private readonly inner: AmpAcpAgent;
  private readonly inflightBySession = new Map<string, number>();

  constructor() {
    const fakeClient: V1ClientLike = {
      sessionUpdate: (notification) => this.sendV1Notification(notification),
      requestPermission: async () => {
        throw new Error(
          'ACP v2 permission prompts are not translated yet; run Amp with the default or bypass permission mode',
        );
      },
      readTextFile: async () => {
        throw new Error('ACP v2 clients do not expose fs/read_text_file; use local tools instead');
      },
      writeTextFile: async () => {
        throw new Error('ACP v2 clients do not expose fs/write_text_file; use local tools instead');
      },
    };
    this.inner = new AmpAcpAgent(fakeClient as unknown as AgentSideConnection);
    this.app = agent()
      .onConnect((connection) => {
        this.connection = connection;
      })
      .onRequest(AGENT_METHODS.initialize, ({ params }) => this.initialize(params))
      .onRequest(AGENT_METHODS.session_new, ({ params }) => this.newSession(params))
      .onRequest(AGENT_METHODS.session_resume, ({ params }) => this.resumeSession(params))
      .onRequest(AGENT_METHODS.session_close, ({ params }) => this.closeSession(params))
      .onRequest(AGENT_METHODS.session_list, () => ({ sessions: [] }))
      .onRequest(AGENT_METHODS.session_set_config_option, ({ params }) => this.setConfigOption(params))
      .onRequest(AGENT_METHODS.session_prompt, ({ params }) => this.prompt(params))
      .onNotification(AGENT_METHODS.session_cancel, ({ params }) => this.cancel(params));
  }

  connect(stream: v2.Stream): AgentConnection {
    return this.app.connect(stream);
  }

  private async initialize(request: v2.InitializeRequest): Promise<v2.InitializeResponse> {
    const response: InitializeResponse = await this.inner.initialize({
      protocolVersion: 1,
      clientCapabilities: request.capabilities as unknown as InitializeRequest['clientCapabilities'],
    });
    const v1Capabilities = response.agentCapabilities;
    return {
      protocolVersion: PROTOCOL_VERSION,
      info: {
        name: response.agentInfo?.name ?? 'amp-acp',
        title: response.agentInfo?.title ?? 'Amp ACP Agent',
        version: response.agentInfo?.version || PACKAGE_VERSION,
      },
      capabilities: {
        session: {
          prompt: {
            ...(v1Capabilities?.promptCapabilities?.image ? { image: {} } : {}),
            ...(v1Capabilities?.promptCapabilities?.embeddedContext ? { embeddedContext: {} } : {}),
          },
          mcp: {
            ...(v1Capabilities?.mcpCapabilities?.http || v1Capabilities?.mcpCapabilities?.sse
              ? { http: {} }
              : {}),
            stdio: {},
          },
        },
        ...(v1Capabilities?._meta ? { _meta: v1Capabilities._meta } : {}),
      },
      authMethods: response.authMethods?.flatMap((method) => {
        if (!('type' in method) || method.type !== 'terminal') return [];
        const terminal = method as typeof method & { args?: string[] };
        return [{
          type: 'terminal' as const,
          methodId: method.id,
          name: method.name,
          ...(method.description ? { description: method.description } : {}),
          args: terminal.args ?? [],
        }];
      }),
    };
  }

  private async newSession(request: v2.NewSessionRequest): Promise<v2.NewSessionResponse> {
    const session: NewSessionResponse = await this.inner.newSession({
      cwd: request.cwd,
      ...(request.additionalDirectories ? { additionalDirectories: request.additionalDirectories } : {}),
      mcpServers: toV1McpServers(request.mcpServers),
    } as NewSessionRequest);
    const availableCommands = (session as { availableCommands?: v2.NewSessionResponse['availableCommands'] })
      .availableCommands;
    return {
      sessionId: session.sessionId,
      configOptions: toAcpV2ConfigOptions(session.configOptions),
      ...(availableCommands ? { availableCommands } : {}),
    };
  }

  private async resumeSession(request: v2.ResumeSessionRequest): Promise<v2.ResumeSessionResponse> {
    const session = await this.inner.resumeSession({
      sessionId: request.sessionId,
      cwd: request.cwd,
      mcpServers: toV1McpServers(request.mcpServers),
    });
    return { configOptions: toAcpV2ConfigOptions(session.configOptions) };
  }

  private async closeSession(request: v2.CloseSessionRequest): Promise<void> {
    await this.inner.cancel({ sessionId: request.sessionId } as CancelNotification);
    this.inner.sessions.delete(request.sessionId);
  }

  private async setConfigOption(
    request: v2.SetSessionConfigOptionRequest,
  ): Promise<v2.SetSessionConfigOptionResponse> {
    const response = await this.inner.setSessionConfigOption(request as unknown as Parameters<AmpAcpAgent['setSessionConfigOption']>[0]);
    return { configOptions: toAcpV2ConfigOptions(response.configOptions) ?? [] };
  }

  private async prompt(request: v2.PromptRequest): Promise<v2.PromptResponse> {
    const messageId = messageIdFor(request.sessionId);
    const text = textFromPrompt(request.prompt as unknown as PromptRequest['prompt']);
    this.inflightBySession.set(request.sessionId, (this.inflightBySession.get(request.sessionId) ?? 0) + 1);

    // v2 returns immediately; the turn runs in the background and reports its
    // state through session/update notifications.
    await this.sendUpdate(request.sessionId, {
      sessionUpdate: 'user_message_chunk',
      messageId,
      content: { type: 'text', text },
    });
    await this.sendUpdate(request.sessionId, { sessionUpdate: 'state_update', state: 'running' });

    void this.inner
      .prompt({
        sessionId: request.sessionId,
        prompt: request.prompt as unknown as PromptRequest['prompt'],
      })
      .then(
        (response) => this.finishTurn(request.sessionId, response.stopReason, response.usage),
        (error: unknown) => this.failTurn(request.sessionId, error),
      );

    return { messageId };
  }

  private async cancel(request: v2.CancelSessionNotification): Promise<void> {
    await this.inner.cancel({ sessionId: request.sessionId } as CancelNotification);
  }

  private finishTurn(
    sessionId: string,
    stopReason: PromptResponse['stopReason'],
    usage: PromptResponse['usage'],
  ): void {
    void this.sendUpdate(sessionId, {
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason,
      usage: usage as unknown as v2.Usage,
    }).finally(() => this.releaseTurn(sessionId));
  }

  private failTurn(sessionId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void this.sendUpdate(sessionId, {
      sessionUpdate: 'notice',
      severity: 'error',
      title: 'Amp request failed',
      description: message,
    }).finally(() => {
      void this.sendUpdate(sessionId, {
        sessionUpdate: 'state_update',
        state: 'idle',
        stopReason: 'refusal',
      }).finally(() => this.releaseTurn(sessionId));
    });
  }

  private releaseTurn(sessionId: string): void {
    const next = (this.inflightBySession.get(sessionId) ?? 1) - 1;
    if (next <= 0) {
      this.inflightBySession.delete(sessionId);
    } else {
      this.inflightBySession.set(sessionId, next);
    }
  }

  private async sendV1Notification(notification: SessionNotification): Promise<void> {
    const update = notification.update;
    // The v2 facade emits the user message itself so the prompt response and
    // the echoed message always share one messageId.
    if (update.sessionUpdate === 'user_message_chunk') return;

    await this.sendUpdate(notification.sessionId, toAcpV2Update(update));
  }

  private async sendUpdate(sessionId: string, update: v2.SessionUpdate): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.client.notify(CLIENT_METHODS.session_update, { sessionId, update });
    } catch (error) {
      console.error('[acp-v2] session/update failed', error);
    }
  }
}
