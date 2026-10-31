import {
  RequestError,
  type AgentSideConnection,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ClientCapabilities,
  type SessionConfigOption,
  type LoadSessionRequest,
  type LoadSessionResponse,
} from '@agentclientprotocol/sdk';
import {
  createAmpTransport,
  isAmpThreadId,
  setAmpThreadArchived,
  type AmpEffort,
  type AmpExecutionOptions,
  type AmpPromptContent,
  type AmpThreadLifecycleOptions,
  type AmpTransport,
} from './amp-transport.js';
import { convertAcpMcpServersToAmpConfig, type AmpMcpConfig } from './mcp-config.js';
import {
  FileThreadMappingStore,
  type AmpThreadMapping,
  type ThreadMappingStore,
} from './thread-mapping-store.js';
import { discoverPluginModes as discoverPluginModesFromDir, type PluginAgentMode } from './plugin-modes.js';
import { TurnUsage } from './turn-usage.js';
import {
  contextWindowSize,
  isMcpProblemStatus,
  mcpNoticeSeverity,
  mcpStatusReports,
  permissionDenialNames,
  stopReasonFromAssistant,
} from './turn-events.js';
import { toAcpNotifications } from './to-acp.js';
import { exportThreadDetails, exportThreadHistory, historyToNotifications, type ThreadHistoryExporter } from './thread-history.js';
import path from 'node:path';
import packageJson from '../package.json';

const PACKAGE_VERSION: string = packageJson.version;
const CONFIG_PERMISSION = 'permission';
const CONFIG_AMP_MODE = 'amp-mode';
const CONFIG_EXECUTOR = 'execution-environment';
const CONFIG_REASONING_EFFORT = 'reasoning-effort';
/** Maximum number of prompts accepted behind the active turn for one session. */
const MAX_QUEUED_PROMPTS = 32;
const MAX_SESSION_TITLE_LENGTH = 60;
const FALLBACK_SESSION_TITLE = 'Amp session';

/** Derive a stable title from the first user turn without calling a model. */
function titleFromPrompt(prompt: PromptRequest['prompt']): string {
  const text = prompt
    .flatMap((chunk) => chunk.type === 'text' ? [chunk.text] : [])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, MAX_SESSION_TITLE_LENGTH).trim() : FALLBACK_SESSION_TITLE;
}
const PERMISSION_MODES = ['default', 'bypass'] as const;
const EXECUTORS = ['local', 'orb'] as const;

function normalizeBase64ImageData(data: string): string | null {
  const normalized = data.replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const unpadded = normalized.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  if (unpadded.length !== normalized.length && normalized.length % 4 !== 0) return null;
  return normalized;
}
const REASONING_EFFORTS = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type ReasoningEffort = typeof REASONING_EFFORTS[number];
const THREAD_LIFECYCLE_CAPABILITY = 'amp-acp/thread-lifecycle';
const NATIVE_METADATA_METHOD = 'amp-acp/session/native-metadata';
const SET_ARCHIVED_METHOD = 'amp-acp/thread/set-archived';

const AMP_MODELS = [
  {
    modelId: 'low',
    name: 'Low',
    description: 'Fast and economical for simple, well-defined tasks.',
  },
  {
    modelId: 'medium',
    name: 'Medium',
    description: 'Balanced capability and cost for everyday coding tasks.',
  },
  {
    modelId: 'high',
    name: 'High',
    description: 'Greater capability and reasoning for difficult tasks.',
  },
  {
    modelId: 'ultra',
    name: 'Ultra',
    description: 'Maximum capability for the most demanding tasks.',
  },
] as const;

type PermissionMode = typeof PERMISSION_MODES[number];
type Executor = typeof EXECUTORS[number];

interface AmpModel {
  modelId: string;
  name: string;
  description: string;
}

/**
 * Combine built-in Amp modes with agent modes registered by Amp plugins
 * (project, system, personal, and workspace). Built-in modes win on key
 * conflicts; plugins are required not to collide with them, so this is
 * defensive only.
 */
function buildAmpModels(pluginModes: PluginAgentMode[]): AmpModel[] {
  const builtinIds = new Set<string>(AMP_MODELS.map((model) => model.modelId.toLowerCase()));
  return [
    ...AMP_MODELS,
    ...pluginModes
      .filter((mode) => !builtinIds.has(mode.modelId.toLowerCase()))
      .map((mode) => ({
        modelId: mode.modelId,
        name: mode.name,
        description: mode.source
          ? `Custom agent mode registered by the ${mode.source} plugin.`
          : 'Custom agent mode registered by an installed Amp plugin.',
      })),
  ];
}

function isAmpModelId(modelId: string, models: AmpModel[]): boolean {
  return models.some((model) => model.modelId === modelId);
}

function isPermissionMode(mode: string): mode is PermissionMode {
  return PERMISSION_MODES.some((permissionMode) => permissionMode === mode);
}

function isExecutor(executor: string): executor is Executor {
  return EXECUTORS.some((candidate) => candidate === executor);
}

function isReasoningEffort(effort: string): effort is ReasoningEffort {
  return REASONING_EFFORTS.some((candidate) => candidate === effort);
}

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  auto: 'Auto',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const REASONING_EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  auto: "Use Amp's default effort for the selected mode.",
  none: 'Do not request additional reasoning.',
  minimal: 'Minimal reasoning for the fastest responses.',
  low: 'Light reasoning for straightforward tasks.',
  medium: 'Balanced reasoning for everyday coding tasks.',
  high: 'More reasoning for difficult problems.',
  xhigh: 'Extra-high reasoning for complex work.',
  max: 'Maximum reasoning effort.',
};

function buildSessionConfigOptions(
  s: Pick<SessionState, 'mode' | 'model' | 'models' | 'executor' | 'effort'>,
): SessionConfigOption[] {
  const ampModeOptions = s.models.map((model) => ({
    value: model.modelId,
    name: model.name,
    description: model.description,
  }));
  if (!isAmpModelId(s.model, s.models)) {
    // Keep a persisted or passed-through custom mode selectable even when it
    // is not in the discovered list (e.g. its plugin is temporarily
    // unloaded), so the session does not silently fall back to another mode.
    ampModeOptions.push({ value: s.model, name: s.model, description: 'Custom Amp agent mode.' });
  }
  return [
    {
      type: 'select',
      id: CONFIG_EXECUTOR,
      name: 'Execution Environment',
      description: 'Choose whether Amp runs in the local project or a remote Amp Orb.',
      category: 'mode',
      currentValue: s.executor,
      options: [
        {
          value: 'local',
          name: 'Local',
          description: 'Run Amp on this machine in the directory supplied by the ACP client.',
        },
        {
          value: 'orb',
          name: 'Orb',
          description: 'Run Amp remotely. Project settings control permissions and MCP servers.',
        },
      ],
    },
    {
      type: 'select',
      id: CONFIG_PERMISSION,
      name: 'Permissions',
      description: 'Controls whether Amp uses configured permissions or force-allows tool calls.',
      category: 'mode',
      currentValue: s.mode,
      options: [
        {
          value: 'default',
          name: 'Default',
          description:
            "Use Amp's configured behavior. As of Amp Neo, tools run without prompts unless you've opted into permissions.",
        },
        {
          value: 'bypass',
          name: 'Bypass',
          description: 'Force-allow every tool call, overriding any configured permissions plugin.',
        },
      ],
    },
    {
      type: 'select',
      id: CONFIG_AMP_MODE,
      name: 'Amp Mode',
      description: 'Select the Amp execution mode.',
      category: 'model',
      currentValue: s.model,
      options: ampModeOptions,
    },
    {
      type: 'select',
      id: CONFIG_REASONING_EFFORT,
      name: 'Reasoning Effort',
      description: 'How much reasoning Amp should apply to local CLI turns for the selected mode.',
      category: 'thought_level',
      currentValue: s.effort,
      options: REASONING_EFFORTS.map((effort) => ({
        value: effort,
        name: REASONING_EFFORT_LABELS[effort],
        description: REASONING_EFFORT_DESCRIPTIONS[effort],
      })),
    },
  ];
}

interface ActiveTurn {
  controller: AbortController;
  cancelled: boolean;
}

interface QueuedPrompt {
  params: PromptRequest;
  resolve: (response: PromptResponse) => void;
  reject: (error: unknown) => void;
}

interface SessionState {
  threadId: string | null;
  active: ActiveTurn | null;
  queue: QueuedPrompt[];
  mode: PermissionMode;
  model: string;
  models: AmpModel[];
  effort: ReasoningEffort;
  executor: Executor;
  mcpConfig: AmpMcpConfig;
  cwd: string;
  title?: string;
  updatedAt?: string;
  /** Last reported status per MCP server, used to avoid repeating notices. */
  mcpStatuses: Map<string, string>;
}

interface InitializeResponseWithAgentInfo extends InitializeResponse {
  agentInfo: {
    name: string;
    title: string;
    version: string;
  };
}

type SetThreadArchived = (
  threadId: string,
  archived: boolean,
  options?: AmpThreadLifecycleOptions,
) => Promise<void>;

interface AmpAcpAgentOptions {
  threadStore?: ThreadMappingStore;
  setThreadArchived?: SetThreadArchived;
  exportThread?: ThreadHistoryExporter;
  /** Transport used for Orb execution; defaults to the Amp SDK transport. */
  orbTransport?: AmpTransport;
  /** Retry policy for empty history exports on session/load; mainly for tests. */
  replayRetry?: { attempts: number; delayMs: number };
  /** Override plugin-mode discovery; tests pass a stub to isolate from local plugins. */
  discoverPluginModes?: (cwd: string) => PluginAgentMode[];
}

export class AmpAcpAgent implements Agent {
  private client: AgentSideConnection;
  private transport: AmpTransport;
  private orbTransport: AmpTransport;
  private threadStore: ThreadMappingStore;
  private setThreadArchived: SetThreadArchived;
  sessions = new Map<string, SessionState>();
  private clientCapabilities?: ClientCapabilities;

  private exportThread: ThreadHistoryExporter;
  private replayRetry: { attempts: number; delayMs: number };
  private discoverPluginModes: (cwd: string) => PluginAgentMode[];
  private warnedUnsupportedEffort = false;

  constructor(
    client: AgentSideConnection,
    transport = createAmpTransport(),
    options: AmpAcpAgentOptions = {},
  ) {
    this.client = client;
    this.transport = transport;
    this.orbTransport = options.orbTransport ?? createAmpTransport('sdk');
    this.threadStore = options.threadStore ?? new FileThreadMappingStore();
    this.setThreadArchived = options.setThreadArchived ?? setAmpThreadArchived;
    this.exportThread = options.exportThread ?? exportThreadHistory;
    this.replayRetry = options.replayRetry ?? { attempts: 5, delayMs: 2000 };
    this.discoverPluginModes = options.discoverPluginModes ?? discoverPluginModesFromDir;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponseWithAgentInfo> {
    this.clientCapabilities = request.clientCapabilities;
    console.info(`[acp] amp-acp v${PACKAGE_VERSION} initialized`);
    return {
      protocolVersion: 1,
      agentInfo: {
        name: 'amp-acp',
        title: 'Amp ACP Agent',
        version: PACKAGE_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { resume: {} },
        _meta: {
          [THREAD_LIFECYCLE_CAPABILITY]: {
            version: 1,
            methods: {
              nativeMetadata: NATIVE_METADATA_METHOD,
              setArchived: SET_ARCHIVED_METHOD,
            },
          },
        },
      },
      authMethods: [
        {
          id: 'setup',
          name: 'Amp API Key Setup',
          description: 'Run interactive setup to configure your Amp API key',
          ...(request.clientCapabilities?.auth?.terminal === true ? {
            type: 'terminal',
            args: ['--setup'],
          } : {
            _meta: {
              'terminal-auth': {
                command: getTerminalAuthCommand(),
                args: ['--setup'],
                label: 'Amp API Key Setup',
              },
            },
          }),
        },
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const mcpConfig = convertAcpMcpServersToAmpConfig(params.mcpServers);
    const cwd = params.cwd || process.cwd();

    const session: SessionState = {
      threadId: null,
      active: null,
      queue: [],
      mode: 'default',
      model: 'medium',
      models: buildAmpModels(this.discoverPluginModes(cwd)),
      effort: 'auto',
      executor: 'local',
      mcpConfig,
      cwd,
      mcpStatuses: new Map(),
    };
    this.sessions.set(sessionId, session);

    const result: NewSessionResponse = {
      sessionId,
      configOptions: buildSessionConfigOptions(session),
    };

    setImmediate(async () => {
      try {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              {
                name: 'init',
                description: 'Generate an AGENTS.md file for the project',
              },
            ],
          },
        });
      } catch (e) {
        console.error('[acp] failed to send available_commands_update', e);
      }
    });

    return result;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    let session = this.sessions.get(params.sessionId);

    if (!session) {
      const mapping = await this.threadStore.load(params.sessionId);
      if (!mapping) {
        throw RequestError.invalidParams(undefined, `No durable Amp thread mapping for ACP session ${params.sessionId}`);
      }
      session = this.sessionFromMapping(mapping, params);
      this.sessions.set(params.sessionId, session);
      console.error(`[acp] loaded session ${params.sessionId} -> thread ${mapping.threadId}`);
    }

    if (session.threadId) {
      try {
        const thread = await exportThreadDetails(
          this.exportThread,
          session.threadId,
          session.cwd,
          this.replayRetry.attempts,
          this.replayRetry.delayMs,
        );
        const exportedTitle = thread.title
          ?.replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_SESSION_TITLE_LENGTH)
          .trim();
        if (exportedTitle) session.title = exportedTitle;
        if (thread.updatedAt) session.updatedAt = thread.updatedAt;
        for (const notification of historyToNotifications(thread.messages, params.sessionId)) {
          await this.client.sessionUpdate(notification);
        }
      } catch (e) {
        // History replay is best-effort: the thread still continues correctly
        // without it, so a failed export must not fail the load.
        console.error('[acp] failed to replay thread history', e);
      }
      await this.publishSessionInfo(params.sessionId, session);
    }

    setImmediate(async () => {
      try {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              {
                name: 'init',
                description: 'Generate an AGENTS.md file for the project',
              },
            ],
          },
        });
      } catch (e) {
        console.error('[acp] failed to send available_commands_update', e);
      }
    });

    return {
      configOptions: buildSessionConfigOptions(session),
    };
  }

  private sessionFromMapping(
    mapping: AmpThreadMapping,
    params: ResumeSessionRequest | LoadSessionRequest,
  ): SessionState {
    const cwd = params.cwd || mapping.cwd || process.cwd();
    const models = buildAmpModels(this.discoverPluginModes(cwd));
    return {
      threadId: mapping.threadId,
      active: null,
      queue: [],
      mode: mapping.mode && isPermissionMode(mapping.mode) ? mapping.mode : 'default',
      // Keep the persisted Amp mode even when discovery does not currently
      // list it (e.g. its plugin is temporarily unloaded); Amp is the
      // authority on resolving or rejecting it when the prompt runs.
      model: mapping.model?.trim() ? mapping.model : 'medium',
      models,
      effort: mapping.effort && isReasoningEffort(mapping.effort) ? mapping.effort : 'auto',
      executor: mapping.executor && isExecutor(mapping.executor) ? mapping.executor : 'local',
      mcpConfig: convertAcpMcpServersToAmpConfig(params.mcpServers),
      cwd,
      ...(mapping.title ? { title: mapping.title } : {}),
      ...(mapping.updatedAt ? { updatedAt: mapping.updatedAt } : {}),
      mcpStatuses: new Map(),
    };
  }

  private async persistSession(sessionId: string, s: SessionState): Promise<void> {
    if (!s.threadId) return;
    await this.threadStore.save({
      sessionId,
      threadId: s.threadId,
      mode: s.mode,
      model: s.model,
      effort: s.effort,
      executor: s.executor,
      cwd: s.cwd,
      ...(s.title ? { title: s.title } : {}),
      ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
    });
  }

  /** Persist best-effort: a failed write must not reject a config change. */
  private async persistSessionQuiet(sessionId: string, s: SessionState): Promise<void> {
    try {
      await this.persistSession(sessionId, s);
    } catch (e) {
      console.error('[acp] failed to persist session settings', e);
    }
  }

  /** Persist and publish the current title/timestamp for a session. */
  private async publishSessionInfo(sessionId: string, s: SessionState): Promise<void> {
    await this.persistSessionQuiet(sessionId, s);
    if (!s.title && !s.updatedAt) return;
    try {
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          ...(s.title ? { title: s.title } : {}),
          ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
        },
      });
    } catch (e) {
      console.error('[acp] failed to send session_info_update', e);
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    if (process.env.AMP_API_KEY) {
      return {};
    }
    throw RequestError.authRequired();
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const mapping = await this.threadStore.load(params.sessionId);
    if (!mapping) {
      throw RequestError.invalidParams(undefined, `No durable Amp thread mapping for ACP session ${params.sessionId}`);
    }
    const session = this.sessionFromMapping(mapping, params);
    this.sessions.set(params.sessionId, session);
    await this.publishSessionInfo(params.sessionId, session);
    return { configOptions: buildSessionConfigOptions(session) };
  }

  private supportsNotices(): boolean {
    return this.clientCapabilities?.session?.notices != null;
  }

  /** Prefer an ACP notice when supported; otherwise keep the text in the transcript. */
  private async sendAdvisory(
    sessionId: string,
    severity: 'info' | 'warning' | 'error',
    title: string,
    description?: string,
  ): Promise<void> {
    try {
      if (this.supportsNotices()) {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'notice',
            severity,
            title,
            ...(description ? { description } : {}),
          },
        });
        return;
      }
      const text = description ? `${title}\n${description}` : title;
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      });
    } catch (e) {
      console.error('[acp] failed to send advisory update', e);
    }
  }

  private async sendMcpNotices(
    sessionId: string,
    s: SessionState,
    message: { type?: string; subtype?: string; mcp_servers?: unknown },
  ): Promise<void> {
    if (message.type !== 'system' || message.subtype !== 'init') return;
    const reports = mcpStatusReports(message.mcp_servers);
    if (reports.length === 0) return;

    const problems = reports.filter(
      (report) => isMcpProblemStatus(report.status) && s.mcpStatuses.get(report.name) !== report.status,
    );
    for (const report of reports) s.mcpStatuses.set(report.name, report.status);
    if (problems.length === 0) return;

    const severity = problems.some((report) => mcpNoticeSeverity(report.status) === 'error') ? 'error' : 'warning';
    const title = problems.length === 1 ? 'MCP server unavailable' : `${problems.length} MCP servers unavailable`;
    const description = `${problems.map((report) => `${report.name}: ${report.status}`).join('\n')}\nReview this session's MCP configuration.`;
    await this.sendAdvisory(sessionId, severity, title, description);
  }

  private async sendPermissionDenialNotice(
    sessionId: string,
    message: { type?: string; permission_denials?: unknown },
  ): Promise<void> {
    if (message.type !== 'result') return;
    const names = [...new Set(permissionDenialNames(message.permission_denials))];
    if (names.length === 0) return;
    await this.sendAdvisory(
      sessionId,
      'warning',
      'Amp permission denied',
      `Blocked tool calls: ${names.join(', ')}. Check the session's Amp permission settings.`,
    );
  }

  private async sendUsageUpdate(
    sessionId: string,
    turnUsage: TurnUsage,
    previous: { used: number; size: number } | null,
  ): Promise<{ used: number; size: number } | null> {
    const used = turnUsage.latestContextTokens();
    if (used === null) return previous;
    const size = contextWindowSize();
    if (previous?.used === used && previous.size === size) return previous;
    try {
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'usage_update', used, size },
      });
      return { used, size };
    } catch (e) {
      console.error('[acp] failed to send usage_update', e);
      return previous;
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (s.active || s.queue.length > 0) {
      return this.enqueuePrompt(params, s);
    }
    return this.startPrompt(params, s);
  }

  private enqueuePrompt(params: PromptRequest, s: SessionState): Promise<PromptResponse> {
    if (s.queue.length >= MAX_QUEUED_PROMPTS) {
      return Promise.reject(RequestError.invalidParams(
        undefined,
        `Prompt queue is full (max ${MAX_QUEUED_PROMPTS} pending prompts)`,
      ));
    }
    return new Promise<PromptResponse>((resolve, reject) => {
      s.queue.push({ params, resolve, reject });
    });
  }

  private startPrompt(params: PromptRequest, s: SessionState): Promise<PromptResponse> {
    const turn: ActiveTurn = { controller: new AbortController(), cancelled: false };
    s.active = turn;
    return this.executePrompt(params, s, turn).finally(() => {
      if (s.active === turn) s.active = null;
      // Let the current prompt response reach the client before starting the
      // next queued turn.
      setImmediate(() => this.startNextQueuedPrompt(s));
    });
  }

  private startNextQueuedPrompt(s: SessionState): void {
    if (s.active) return;
    const next = s.queue.shift();
    if (!next) return;
    void this.startPrompt(next.params, s).then(next.resolve, next.reject);
  }

  private async executePrompt(
    params: PromptRequest,
    s: SessionState,
    turn: ActiveTurn,
  ): Promise<PromptResponse> {
    let textInput = '';
    let pendingText = '';
    const content: AmpPromptContent[] = [];
    for (const chunk of params.prompt) {
      const textStart = textInput.length;
      switch (chunk.type) {
        case 'text':
          if (chunk.text.trim() === '/init') {
            textInput += `Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Architecture and codebase structure information, including important subprojects, internal APIs, databases, etc.
3. Code style guidelines, including imports, conventions, formatting, types, naming conventions, error handling, etc.

The file you create will be given to agentic coding tools (such as yourself) that operate in this repository. Make it about 20 lines long.

If there are Cursor rules (in .cursor/rules/ or .cursorrules), Claude rules (CLAUDE.md), Windsurf rules (.windsurfrules), Cline rules (.clinerules), Goose rules (.goosehints), or Copilot rules (in .github/copilot-instructions.md), make sure to include them. Also, first check if there is an existing AGENTS.md or AGENT.md file, and if so, update it instead of overwriting it.`;
          } else {
            textInput += chunk.text;
          }
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
          if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(chunk.mimeType)) {
            throw RequestError.invalidParams(undefined, `Unsupported image MIME type: ${chunk.mimeType}. Use PNG, JPEG, GIF, or WebP.`);
          }
          const imageData = normalizeBase64ImageData(chunk.data);
          if (!imageData) {
            throw RequestError.invalidParams(undefined, 'Image data must be non-empty base64.');
          }
          if (pendingText) content.push({ type: 'text', text: pendingText });
          pendingText = '';
          content.push({ type: 'image', source: { type: 'base64', media_type: chunk.mimeType, data: imageData } });
          break;
        default:
          break;
      }
      pendingText += textInput.slice(textStart);
    }
    if (pendingText) content.push({ type: 'text', text: pendingText });
    const hasImages = content.some((block) => block.type === 'image');
    if (!s.title) s.title = titleFromPrompt(params.prompt);

    const transport = s.executor === 'orb' ? this.orbTransport : this.transport;
    const effort: AmpEffort | undefined = s.effort === 'auto' ? undefined : s.effort;
    // Local image turns run through the CLI even on the SDK transport.
    const effortSupported = transport.name === 'cli' || (hasImages && s.executor !== 'orb');
    if (effort && !effortSupported && !this.warnedUnsupportedEffort) {
      this.warnedUnsupportedEffort = true;
      console.error('[acp] reasoning effort is only supported by the CLI transport; ignoring it for this agent process');
    }
    const options: AmpExecutionOptions = {
      cwd: s.cwd,
      env: { TERM: 'dumb' },
      mode: s.model,
      ...(effort && effortSupported ? { effort } : {}),
      thinking: process.env.AMP_ACP_DISABLE_THINKING !== '1',
      executor: s.executor,
    };

    if (s.executor === 'orb') {
      const project = process.env.AMP_ACP_ORB_PROJECT?.trim();
      if (project) options.project = project;
    } else {
      if (s.mode === 'bypass') {
        options.dangerouslyAllowAll = true;
      }

      if (Object.keys(s.mcpConfig).length > 0) {
        options.mcpConfig = s.mcpConfig;
      }
    }

    if (s.threadId) {
      options.continue = s.threadId;
    } else if (process.env.AMP_ACP_CONTINUE_LATEST) {
      options.continue = true;
      console.error('[acp] AMP_ACP_CONTINUE_LATEST set; continuing latest thread on this installation');
    }

    const turnUsage = new TurnUsage();
    let lastUsage: { used: number; size: number } | null = null;
    let stopReason: PromptResponse['stopReason'] = 'end_turn';

    try {
      for await (const message of transport.execute({ prompt: textInput, ...(hasImages ? { content } : {}), options, signal: turn.controller.signal })) {
        turnUsage.add(message);
        await this.sendMcpNotices(params.sessionId, s, message);
        await this.sendPermissionDenialNotice(params.sessionId, message);
        if (message.type === 'assistant') {
          const mappedStopReason = stopReasonFromAssistant(message.message?.stop_reason);
          if (mappedStopReason) stopReason = mappedStopReason;
        }
        if (message.type === 'result' && message.subtype === 'error_max_turns') {
          stopReason = 'max_turn_requests';
        }
        if (message.session_id) {
          if (!isAmpThreadId(message.session_id)) {
            throw new Error(`Amp returned an invalid thread ID: ${message.session_id}`);
          }
          if (s.threadId && s.threadId !== message.session_id) {
            throw new Error(`Amp changed thread ID from ${s.threadId} to ${message.session_id}`);
          }
          if (!s.threadId) {
            s.threadId = message.session_id;
            await this.persistSession(params.sessionId, s);
            console.error(`[amp] thread ${s.threadId}`);
          }
        }

        if (message.type === 'assistant' || message.type === 'user') {
          for (const n of toAcpNotifications(message, params.sessionId)) {
            try {
              await this.client.sessionUpdate(n);
            } catch (e) {
              console.error('[acp] sessionUpdate failed', e);
            }
          }
        }

        if (message.type === 'result' && message.is_error) {
          if (typeof message.error === 'string' && isAuthError(message.error)) {
            console.error('[amp] Auth error in result, requesting authentication:', message.error);
            throw RequestError.authRequired();
          }
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Error: ${message.error}` } },
          });
        }

        lastUsage = await this.sendUsageUpdate(params.sessionId, turnUsage, lastUsage);
      }

      const usage = turnUsage.toAcp();
      return { stopReason: turn.cancelled ? 'cancelled' : stopReason, ...(usage ? { usage } : {}) };
    } catch (err) {
      if (turn.cancelled || (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted')))) {
        return { stopReason: 'cancelled' };
      }
      if (err instanceof Error && isAuthError(err.message)) {
        console.error('[amp] Auth error, requesting authentication:', err.message);
        throw RequestError.authRequired();
      }
      console.error('[amp] Execution error:', err);
      throw err;
    } finally {
      s.updatedAt = new Date().toISOString();
      await this.publishSessionInfo(params.sessionId, s);
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return;

    if (s.active) {
      s.active.cancelled = true;
      s.active.controller.abort();
    }

    const queued = s.queue.splice(0);
    for (const entry of queued) {
      entry.resolve({ stopReason: 'cancelled' });
    }
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (typeof params.value !== 'string') {
      throw new Error(`Unsupported value for ${params.configId}`);
    }

    switch (params.configId) {
      case CONFIG_EXECUTOR:
        if (!isExecutor(params.value)) {
          throw new Error(`Unsupported execution environment: ${params.value}`);
        }
        s.executor = params.value;
        break;
      case CONFIG_PERMISSION:
        if (!isPermissionMode(params.value)) {
          throw new Error(`Unsupported permission mode: ${params.value}`);
        }
        s.mode = params.value;
        break;
      case CONFIG_AMP_MODE: {
        // Amp accepts built-in modes and plugin-provided custom agent modes
        // by key (case-insensitive). Discovery can lag Amp — a mode plugin
        // installed after the last discovery is valid before amp-acp lists
        // it — so any non-empty value passes through to Amp, which is the
        // authority and rejects unknown modes when the prompt runs.
        const mode = params.value.trim();
        if (!mode) {
          throw new Error('Amp mode must be a non-empty string');
        }
        s.model = mode;
        break;
      }
      case CONFIG_REASONING_EFFORT:
        if (!isReasoningEffort(params.value)) {
          throw new Error(`Unsupported reasoning effort: ${params.value}`);
        }
        s.effort = params.value;
        break;
      default:
        throw new Error(`Unsupported config option: ${params.configId}`);
    }

    await this.persistSessionQuiet(params.sessionId, s);

    const configOptions = buildSessionConfigOptions(s);
    try {
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions,
        },
      });
    } catch (e) {
      console.error('[acp] failed to send config_option_update', e);
    }

    return { configOptions };
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error('Session not found');
    if (!isPermissionMode(params.modeId)) {
      throw new Error(`Unsupported mode: ${params.modeId}`);
    }
    s.mode = params.modeId;
    await this.persistSessionQuiet(params.sessionId, s);
    return {};
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (method) {
      case NATIVE_METADATA_METHOD:
        return this.nativeMetadata(params);
      case SET_ARCHIVED_METHOD:
        return this.updateArchivedState(params);
      default:
        throw RequestError.methodNotFound(method);
    }
  }

  private async nativeMetadata(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof params.sessionId !== 'string') {
      throw RequestError.invalidParams(undefined, 'sessionId must be a string');
    }
    const activeThreadId = this.sessions.get(params.sessionId)?.threadId ?? null;
    const persisted = activeThreadId ? null : await this.threadStore.load(params.sessionId);
    return {
      version: 1,
      sessionId: params.sessionId,
      ampThreadId: activeThreadId ?? persisted?.threadId ?? null,
    };
  }

  private async updateArchivedState(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof params.sessionId !== 'string') {
      throw RequestError.invalidParams(undefined, 'sessionId must be a string');
    }
    if (!isAmpThreadId(params.threadId)) {
      throw RequestError.invalidParams(undefined, 'threadId must be a durable Amp T-... thread ID');
    }
    if (typeof params.archived !== 'boolean') {
      throw RequestError.invalidParams(undefined, 'archived must be a boolean');
    }

    const active = this.sessions.get(params.sessionId);
    const persisted = await this.threadStore.load(params.sessionId);
    const mappedThreadId = active?.threadId ?? persisted?.threadId ?? null;
    if (!mappedThreadId) {
      throw RequestError.invalidParams(
        undefined,
        `No durable Amp thread mapping for ACP session ${params.sessionId}`,
      );
    }
    if (mappedThreadId !== params.threadId) {
      throw RequestError.invalidParams(
        undefined,
        `Amp thread ${params.threadId} does not match ACP session ${params.sessionId}`,
      );
    }

    await this.setThreadArchived(params.threadId, params.archived);
    return { version: 1, threadId: params.threadId, archived: params.archived };
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> { return this.client.readTextFile(params); }
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> { return this.client.writeTextFile(params); }
}

export function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('invalid or missing api key') ||
    lower.includes("run 'amp login'") ||
    lower.includes('authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('no api key found') ||
    (lower.includes('api key') && lower.includes('login flow')) ||
    (lower.includes('api key') && (lower.includes('missing') || lower.includes('invalid')));
}

export function getTerminalAuthCommand(
  argv1: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string {
  const resolvedArgv1 = argv1 ? path.resolve(argv1) : '';
  if (!resolvedArgv1 || resolvedArgv1.startsWith('/$bunfs/')) {
    return execPath;
  }
  return resolvedArgv1;
}
