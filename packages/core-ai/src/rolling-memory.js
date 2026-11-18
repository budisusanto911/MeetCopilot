import { TOKEN_BUDGETS } from './constants.js';
import { truncateToTokenBudget } from './token-estimator.js';

/**
 * Maintains a bounded sliding window of recent turns plus a deterministic
 * compressed rolling summary so long meetings never bloat prompt tokens.
 */
export class RollingMemory {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxTurns]
   * @param {number} [opts.maxSummaryTokens]
   */
  constructor({
    maxTurns = TOKEN_BUDGETS.maxHistoryTurns,
    maxSummaryTokens = TOKEN_BUDGETS.maxSummaryTokens
  } = {}) {
    this.maxTurns = maxTurns;
    this.maxSummaryTokens = maxSummaryTokens;
    this.turns = [];
    this.summary = '';
  }

  /**
   * Append a completed speaker turn and fold overflow into rolling summary.
   * @param {{ speaker: string, text: string, translation?: string, reply?: string }} turn
   */
  addTurn(turn) {
    if (!turn?.text) return;
    this.turns.push({
      speaker: turn.speaker || 'other',
      text: String(turn.text).trim(),
      translation: turn.translation ? String(turn.translation).trim() : '',
      reply: turn.reply ? String(turn.reply).trim() : ''
    });

    while (this.turns.length > this.maxTurns) {
      const evicted = this.turns.shift();
      this.#foldIntoSummary(evicted);
    }
  }

  /**
   * Mark the user's chosen/spoken reply on the latest turn.
   * @param {string} replyText
   */
  markLastReply(replyText) {
    if (this.turns.length === 0 || !replyText) return;
    this.turns[this.turns.length - 1].reply = String(replyText).trim();
  }

  #foldIntoSummary(turn) {
    const snippet = truncateToTokenBudget(turn.text, 22);
    const replyPart = turn.reply ? ` -> ${truncateToTokenBudget(turn.reply, 16)}` : '';
    const entry = `${turn.speaker === 'user' ? 'Me' : 'Other'}: ${snippet}${replyPart}`;

    const combined = this.summary ? `${this.summary}; ${entry}` : entry;
    // Keep only recent clauses if exceeding summary budget
    if (combined.length > Math.floor(this.maxSummaryTokens * 3.7)) {
      const clauses = combined.split('; ');
      while (
        clauses.length > 1 &&
        clauses.join('; ').length > Math.floor(this.maxSummaryTokens * 3.7)
      ) {
        clauses.shift();
      }
      this.summary = truncateToTokenBudget(clauses.join('; '), this.maxSummaryTokens);
    } else {
      this.summary = combined;
    }
  }

  getContext() {
    return {
      rollingSummary: this.summary,
      recentTurns: this.turns.map((t) => ({ ...t }))
    };
  }

  reset() {
    this.turns = [];
    this.summary = '';
  }
}
