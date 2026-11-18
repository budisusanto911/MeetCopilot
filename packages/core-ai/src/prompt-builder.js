import { TOKEN_BUDGETS } from './constants.js';
import { estimateMessagesTokens, truncateToTokenBudget } from './token-estimator.js';

/**
 * Immutable system instruction template placed first for prompt prefix caching.
 */
const BASE_SYSTEM_PROMPT = [
  'You are MeetCopilot, a live bilingual meeting assistant (Foreign -> Natural Indonesian).',
  'Keep technical/domain terms intact when translating to natural conversational Indonesian.',
  'Always output EXACTLY 5 single-line fields in this strict wire format, with zero extra commentary:',
  'T|<natural Indonesian translation>',
  'Q|<1 if the speaker expects a reply or answer, 0 if pure statement/transition>',
  'R1|<short natural English reply, 1 sentence>',
  'R2|<detailed context-grounded English reply using CTX/MEM if relevant, 1-2 sentences>',
  'R3|<polite clarifying or buy-time English reply>'
].join('\n');

/**
 * Build an immutable static system prefix + minimal dynamic turn payload.
 * @param {object} params
 * @param {string} params.utterance
 * @param {string} [params.cheatSheet='']
 * @param {string} [params.rollingSummary='']
 * @param {Array<{speaker: string, text: string, reply?: string}>} [params.recentTurns=[]]
 * @param {Array<{source: string, snippet: string}>} [params.ragSnippets=[]]
 * @param {string} [params.userGoal='']
 * @returns {{ messages: Array<{role: string, content: string}>, estimatedInputTokens: number, prefixTokens: number }}
 */
export function buildMeetingPrompt({
  utterance,
  cheatSheet = '',
  rollingSummary = '',
  recentTurns = [],
  ragSnippets = [],
  userGoal = ''
}) {
  const cappedCheatSheet = truncateToTokenBudget(cheatSheet, TOKEN_BUDGETS.maxGlossaryTokens);
  const systemParts = [BASE_SYSTEM_PROMPT];
  if (userGoal) {
    systemParts.push(`MEETING_ROLE: ${truncateToTokenBudget(userGoal, 60)}`);
  }
  if (cappedCheatSheet) {
    systemParts.push(`CHEAT_SHEET:\n${cappedCheatSheet}`);
  }
  const systemContent = systemParts.join('\n\n');

  const dynamicParts = [];
  if (rollingSummary) {
    dynamicParts.push(`MEM: ${truncateToTokenBudget(rollingSummary, TOKEN_BUDGETS.maxSummaryTokens)}`);
  }

  const trimmedHistory = recentTurns.slice(-TOKEN_BUDGETS.maxHistoryTurns);
  if (trimmedHistory.length > 0) {
    const historyLines = trimmedHistory.map((turn) => {
      const base = `${turn.speaker === 'user' ? 'ME' : 'SPK'}: ${truncateToTokenBudget(turn.text, 35)}`;
      return turn.reply ? `${base} -> MY_REPLY: ${truncateToTokenBudget(turn.reply, 28)}` : base;
    });
    dynamicParts.push(`RECENT:\n${historyLines.join('\n')}`);
  }

  if (ragSnippets.length > 0) {
    const formattedCtx = ragSnippets
      .map((item) => `[${item.source}] ${item.snippet}`)
      .join('\n');
    dynamicParts.push(`CTX:\n${truncateToTokenBudget(formattedCtx, TOKEN_BUDGETS.maxRagTokens)}`);
  }

  dynamicParts.push(`U: ${truncateToTokenBudget(utterance, TOKEN_BUDGETS.maxUtteranceTokens)}`);

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: dynamicParts.join('\n\n') }
  ];

  return {
    messages,
    prefixTokens: estimateMessagesTokens([messages[0]]),
    estimatedInputTokens: estimateMessagesTokens(messages)
  };
}
