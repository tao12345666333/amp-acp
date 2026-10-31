import { spawn } from 'node:child_process';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { toAcpNotifications } from './to-acp.js';

export interface ExportedThreadMessage {
  role: string;
  content?: unknown;
}

export interface ExportedThread {
  messages: ExportedThreadMessage[];
  title?: string;
  updatedAt?: string;
}

export type ThreadHistoryExporter = (
  threadId: string,
  cwd: string,
) => Promise<ExportedThreadMessage[] | ExportedThread>;

function normalizeExport(value: ExportedThreadMessage[] | ExportedThread): ExportedThread {
  if (Array.isArray(value)) return { messages: value };
  return {
    messages: Array.isArray(value.messages) ? value.messages : [],
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  };
}

/**
 * Read a thread's full message history via `amp threads export <id>`.
 */
export const exportThreadHistory: ThreadHistoryExporter = (threadId, cwd) => {
  const command = process.env.AMP_CLI_PATH ?? 'amp';
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['threads', 'export', threadId], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        const details = Buffer.concat(stderr).toString().trim();
        reject(new Error(`amp threads export exited with code ${code}${details ? `: ${details}` : ''}`));
        return;
      }
      try {
        const thread = JSON.parse(Buffer.concat(stdout).toString()) as {
          messages?: ExportedThreadMessage[];
          title?: unknown;
          updatedAt?: unknown;
        };
        resolve({
          messages: Array.isArray(thread.messages) ? thread.messages : [],
          ...(typeof thread.title === 'string' ? { title: thread.title } : {}),
          ...(typeof thread.updatedAt === 'string' ? { updatedAt: thread.updatedAt } : {}),
        });
      } catch (e) {
        reject(new Error(`failed to parse amp threads export output: ${e}`));
      }
    });
  });
};

/**
 * Export a thread's messages, retrying briefly when the export comes back
 * empty. Fresh threads can take a few seconds to become visible to
 * `amp threads export`, so an immediate replay after an adapter restart
 * would otherwise come back empty even though the thread is intact.
 */
export async function exportThreadDetails(
  exportThread: ThreadHistoryExporter,
  threadId: string,
  cwd: string,
  attempts = 5,
  delayMs = 2000,
): Promise<ExportedThread> {
  let latest: ExportedThread = { messages: [] };
  for (let attempt = 0; attempt < attempts; attempt++) {
    latest = normalizeExport(await exportThread(threadId, cwd));
    if (latest.messages.length > 0) return latest;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return latest;
}

export async function exportThreadMessages(
  exportThread: ThreadHistoryExporter,
  threadId: string,
  cwd: string,
  attempts = 5,
  delayMs = 2000,
): Promise<ExportedThreadMessage[]> {
  const thread = await exportThreadDetails(exportThread, threadId, cwd, attempts, delayMs);
  return thread.messages;
}

/**
 * Convert exported thread messages into ACP session/update notifications.
 * Exported content blocks use the same shape as Amp's stream-JSON messages,
 * so the streaming mapper is reused as-is.
 */
export function historyToNotifications(
  messages: ExportedThreadMessage[],
  sessionId: string,
): SessionNotification[] {
  const notifications: SessionNotification[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    notifications.push(
      ...toAcpNotifications({ type: message.role, message: { content: message.content } }, sessionId),
    );
  }
  return notifications;
}
