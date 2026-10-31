import type { Usage } from '@agentclientprotocol/sdk';

/** Token counts as Amp's Claude Code-compatible stream reports them. */
interface AmpUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

const usageOf = (value: unknown): AmpUsage | null =>
  value !== null && typeof value === 'object' ? (value as AmpUsage) : null;

/**
 * A turn's token usage, gathered from the Amp stream for `PromptResponse.usage`.
 *
 * Every model response arrives as an `assistant` message carrying that
 * response's `usage`, and one response can arrive as several messages sharing
 * a `message.id` — so usage is kept per id, the last report winning, and
 * summed across ids. The closing `result` message can carry `usage` too; it is
 * used only when no assistant message did, since what it covers is not
 * documented.
 */
export class TurnUsage {
  readonly #byResponse = new Map<string, AmpUsage>();
  #unnamed = 0;
  #latestAssistant: AmpUsage | null = null;
  #result: AmpUsage | null = null;

  add(message: { type?: string; message?: unknown; usage?: unknown }): void {
    if (message.type === 'assistant') {
      const response = message.message !== null && typeof message.message === 'object' ? (message.message as { id?: unknown; usage?: unknown }) : null;
      const usage = usageOf(response?.usage);
      if (!usage) return;
      this.#latestAssistant = usage;
      const id = response?.id;
      this.#byResponse.set(typeof id === 'string' && id !== '' ? id : `unnamed-${this.#unnamed++}`, usage);
      return;
    }
    if (message.type === 'result') this.#result = usageOf(message.usage);
  }

  /**
   * Tokens in the latest model call's context, for ACP `usage_update`.
   *
   * The final response's input plus cache reads and writes plus output is the
   * best approximation of the context the next turn will start from. The
   * closing `result` usage is used only when no assistant response reported
   * usage, since it may describe the whole turn.
   */
  latestContextTokens(): number | null {
    const usage = this.#latestAssistant ?? this.#result;
    if (!usage) return null;
    return count(usage.input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens) +
      count(usage.output_tokens);
  }

  /** Null when the stream reported no usage at all. */
  toAcp(): Usage | null {
    const reports = this.#byResponse.size > 0 ? [...this.#byResponse.values()] : this.#result ? [this.#result] : [];
    if (reports.length === 0) return null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedReadTokens = 0;
    let cachedWriteTokens = 0;
    for (const usage of reports) {
      inputTokens += count(usage.input_tokens);
      outputTokens += count(usage.output_tokens);
      cachedReadTokens += count(usage.cache_read_input_tokens);
      cachedWriteTokens += count(usage.cache_creation_input_tokens);
    }
    return {
      inputTokens,
      outputTokens,
      ...(cachedReadTokens ? { cachedReadTokens } : {}),
      ...(cachedWriteTokens ? { cachedWriteTokens } : {}),
      totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens,
    };
  }
}
