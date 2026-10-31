import type { StopReason } from '@agentclientprotocol/sdk';

/** Conservative default context window used when the environment override is absent. */
export const DEFAULT_CONTEXT_WINDOW_SIZE = 200_000;

const MCP_PROBLEM_STATUSES = new Set([
  'failed',
  'error',
  'denied',
  'reconnecting',
  'needs-auth',
  'unavailable',
  'blocked-by-registry',
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** Parse and validate `AMP_ACP_CONTEXT_WINDOW_SIZE`, falling back conservatively. */
export function contextWindowSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AMP_ACP_CONTEXT_WINDOW_SIZE?.trim();
  if (!raw) return DEFAULT_CONTEXT_WINDOW_SIZE;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WINDOW_SIZE;
}

export interface McpStatusReport {
  name: string;
  status: string;
}

/**
 * Read the MCP connection reports from Amp's `system` init message.
 *
 * Amp currently emits `{ name, status }`; `state` is accepted as a defensive
 * alias because the CLI stream is not a stable public schema.
 */
export function mcpStatusReports(value: unknown): McpStatusReport[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const report = asRecord(entry);
    if (!report) return [];
    const status = nonEmptyString(report.status) ?? nonEmptyString(report.state);
    if (!status) return [];
    const name = nonEmptyString(report.name) ?? nonEmptyString(report.id) ?? `server ${index + 1}`;
    return [{ name, status }];
  });
}

export function isMcpProblemStatus(status: string): boolean {
  return MCP_PROBLEM_STATUSES.has(status.toLowerCase().replaceAll('_', '-'));
}

export function mcpNoticeSeverity(status: string): 'warning' | 'error' {
  return status.toLowerCase().replaceAll('_', '-') === 'failed' ? 'error' : 'warning';
}

/** Extract tool names from Amp's `permission_denials` result field. */
export function permissionDenialNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const denial = asRecord(entry);
    return nonEmptyString(denial?.tool_name) ??
      nonEmptyString(denial?.toolName) ??
      nonEmptyString(denial?.tool) ??
      nonEmptyString(denial?.name) ??
      `tool ${index + 1}`;
  });
}

/** Map Amp's assistant `stop_reason` to an ACP stop reason. */
export function stopReasonFromAssistant(value: unknown): StopReason | null {
  switch (value) {
    case 'end_turn':
    case 'max_tokens':
    case 'refusal':
      return value;
    default:
      return null;
  }
}
