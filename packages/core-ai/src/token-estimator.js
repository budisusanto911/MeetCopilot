/**
 * Lightweight deterministic token estimator and session token meter.
 */

/**
 * Conservatively estimate token count (~3.7 chars per token for mixed EN/ID text).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const normalized = String(text).trim();
  if (!normalized) return 0;
  return Math.ceil(normalized.length / 3.7);
}

/**
 * Estimate total input tokens for an OpenAI chat messages array.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 3; // assistant priming overhead
  for (const msg of messages) {
    total += 4 + estimateTokens(msg?.content || '');
  }
  return total;
}

/**
 * Truncate text on word boundary so it stays within maxTokens.
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string}
 */
export function truncateToTokenBudget(text, maxTokens) {
  if (!text || maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text.trim();

  const maxChars = Math.max(20, Math.floor(maxTokens * 3.7) - 3);
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trim()}...`;
}

/**
 * Tracks runtime token usage and tokens saved via Tier-0 filtering & RAG gating.
 */
export class TokenTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.callsMade = 0;
    this.skippedLocal = 0;
    this.cacheHits = 0;
    this.ragTriggered = 0;
    this.ragSkipped = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.estimatedSavedTokens = 0;
    this.providerCounts = {};
  }

  /**
   * Record a turn handled completely locally at zero LLM cost.
   * @param {'filler'|'phrase'|'cache'} reason
   * @param {number} [assumedBaselineTokens=450]
   */
  recordLocalSkip(reason, assumedBaselineTokens = 450) {
    if (reason === 'cache') {
      this.cacheHits += 1;
    } else {
      this.skippedLocal += 1;
    }
    this.estimatedSavedTokens += assumedBaselineTokens;
  }

  /**
   * Record an executed LLM call.
   * @param {{provider: string, inputTokens: number, outputTokens: number, usedRag: boolean, ragSavedTokens?: number}} entry
   */
  recordCall({ provider, inputTokens, outputTokens, usedRag, ragSavedTokens = 0 }) {
    this.callsMade += 1;
    this.inputTokens += Math.max(0, inputTokens || 0);
    this.outputTokens += Math.max(0, outputTokens || 0);
    if (usedRag) {
      this.ragTriggered += 1;
    } else {
      this.ragSkipped += 1;
      this.estimatedSavedTokens += ragSavedTokens;
    }
    if (provider) {
      this.providerCounts[provider] = (this.providerCounts[provider] || 0) + 1;
    }
  }

  snapshot() {
    return {
      callsMade: this.callsMade,
      skippedLocal: this.skippedLocal,
      cacheHits: this.cacheHits,
      ragTriggered: this.ragTriggered,
      ragSkipped: this.ragSkipped,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      estimatedSavedTokens: this.estimatedSavedTokens,
      providerCounts: { ...this.providerCounts }
    };
  }
}
