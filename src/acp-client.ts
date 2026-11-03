import type { SessionNotification } from '@agentclientprotocol/sdk/unstable';

/**
 * The client-facing operations `AmpAcpAgent` uses. Implemented by the SDK 2
 * `AgentContext` adapter in production and by test doubles.
 */
export interface AcpClient {
  sessionUpdate(notification: SessionNotification): Promise<void>;
  notify(method: string, params: unknown): Promise<void>;
}
