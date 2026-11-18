import { TOKEN_BUDGETS } from './constants.js';
import { evaluateTier0Utterance, PhraseCache } from './filler-filter.js';
import { evaluateContextIntent } from './intent-gate.js';
import { buildMeetingPrompt } from './prompt-builder.js';
import { RollingMemory } from './rolling-memory.js';
import { createStreamParser } from './stream-parser.js';
import { TokenTracker } from './token-estimator.js';

/**
 * High-level orchestration engine combining all 7 token-saving layers:
 * Tier-0 filter + cache -> Intent-gated RAG -> Prefix-cached prompt -> Waterfall stream -> Rolling memory.
 */
export class MeetingCopilotEngine {
  /**
   * @param {object} opts
   * @param {import('./waterfall-client.js').WaterfallAIClient} opts.aiClient
   * @param {(query: string, maxTokens: number) => Promise<Array<{source: string, snippet: string}>>} [opts.retrieveContext]
   * @param {string} [opts.cheatSheet='']
   * @param {string[]} [opts.glossaryTerms=[]]
   * @param {string} [opts.userGoal='']
   */
  constructor({
    aiClient,
    retrieveContext = null,
    cheatSheet = '',
    glossaryTerms = [],
    userGoal = ''
  }) {
    this.aiClient = aiClient;
    this.retrieveContext = retrieveContext;
    this.cheatSheet = cheatSheet;
    this.glossaryTerms = glossaryTerms;
    this.userGoal = userGoal;

    this.phraseCache = new PhraseCache();
    this.memory = new RollingMemory();
    this.tracker = new TokenTracker();
  }

  setMeetingProfile({ cheatSheet = '', glossaryTerms = [], userGoal = '' }) {
    this.cheatSheet = cheatSheet;
    this.glossaryTerms = glossaryTerms;
    this.userGoal = userGoal;
  }

  markUserReply(replyText) {
    this.memory.markLastReply(replyText);
  }

  resetSession() {
    this.memory.reset();
    this.tracker.reset();
  }

  /**
   * Process one completed speaker turn with live streaming updates.
   * @param {object} params
   * @param {string} params.utterance
   * @param {string} [params.speaker='other']
   * @param {boolean} [params.forceDeepContext=false]
   * @param {(partial: object) => void} [params.onPartial]
   */
  async processUtterance({
    utterance,
    speaker = 'other',
    forceDeepContext = false,
    onPartial
  }) {
    // Layer 1-3: Tier-0 noise filler & instant phrase shortcut
    const tier0 = evaluateTier0Utterance(utterance);
    if (tier0.action === 'drop') {
      this.tracker.recordLocalSkip('filler', 420);
      return {
        skipped: true,
        reason: tier0.reason,
        utterance: tier0.text,
        tokens: this.tracker.snapshot()
      };
    }

    if (tier0.action === 'instant') {
      this.tracker.recordLocalSkip('phrase', 450);
      this.memory.addTurn({
        speaker,
        text: tier0.text,
        translation: tier0.result.t
      });
      if (onPartial) onPartial(tier0.result);
      return {
        skipped: false,
        utterance: tier0.text,
        result: tier0.result,
        providerUsed: 'tier0-phrase',
        usedRag: false,
        ragSnippets: [],
        latencyMs: 0,
        tokens: this.tracker.snapshot()
      };
    }

    // Layer 3b: LRU phrase cache hit
    const contextKey = this.userGoal || 'default';
    const cached = this.phraseCache.get(tier0.text, contextKey);
    if (cached && !forceDeepContext) {
      this.tracker.recordLocalSkip('cache', 500);
      this.memory.addTurn({
        speaker,
        text: tier0.text,
        translation: cached.t
      });
      if (onPartial) onPartial(cached);
      return {
        skipped: false,
        utterance: tier0.text,
        result: cached,
        providerUsed: 'tier0-cache',
        usedRag: false,
        ragSnippets: [],
        latencyMs: 0,
        tokens: this.tracker.snapshot()
      };
    }

    // Layer 5: Intent-gated local RAG retrieval
    let ragSnippets = [];
    let usedRag = false;
    const intent = evaluateContextIntent(tier0.text, this.glossaryTerms);
    if (this.retrieveContext && (forceDeepContext || intent.needsRag)) {
      const searchQuery = intent.query || tier0.text;
      ragSnippets = await this.retrieveContext(searchQuery, TOKEN_BUDGETS.maxRagTokens);
      usedRag = ragSnippets.length > 0;
    }

    // Layer 6: Prefix-cached prompt + rolling memory window
    const { rollingSummary, recentTurns } = this.memory.getContext();
    const prompt = buildMeetingPrompt({
      utterance: tier0.text,
      cheatSheet: this.cheatSheet,
      rollingSummary,
      recentTurns,
      ragSnippets,
      userGoal: this.userGoal
    });

    // Layer 4 & 7: Free Waterfall streaming + compact delimited parser
    const parser = createStreamParser((snapshot) => {
      if (onPartial) onPartial(snapshot);
    });

    const completion = await this.aiClient.streamChat({
      messages: prompt.messages,
      maxTokens: TOKEN_BUDGETS.maxOutputTokens,
      onDelta: (delta) => parser.push(delta)
    });

    const result = parser.finalize();
    this.memory.addTurn({
      speaker,
      text: tier0.text,
      translation: result.t
    });

    if (!usedRag) {
      this.phraseCache.set(tier0.text, result, contextKey);
    }

    this.tracker.recordCall({
      provider: completion.providerUsed,
      inputTokens: prompt.estimatedInputTokens,
      outputTokens: completion.estimatedOutputTokens,
      usedRag,
      ragSavedTokens: usedRag ? 0 : TOKEN_BUDGETS.maxRagTokens
    });

    return {
      skipped: false,
      utterance: tier0.text,
      result,
      providerUsed: completion.providerUsed,
      modelUsed: completion.modelUsed,
      attempts: completion.attempts,
      usedRag,
      ragSnippets,
      latencyMs: completion.latencyMs,
      inputTokens: prompt.estimatedInputTokens,
      outputTokens: completion.estimatedOutputTokens,
      tokens: this.tracker.snapshot()
    };
  }
}
