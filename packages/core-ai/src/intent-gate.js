/**
 * Zero-LLM intent gate deciding whether local file RAG retrieval is worth the prompt tokens.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'can', 'may', 'might', 'must', 'i', 'you', 'we', 'they', 'he', 'she', 'it',
  'my', 'your', 'our', 'their', 'this', 'that', 'these', 'those', 'to', 'of',
  'in', 'on', 'at', 'for', 'with', 'about', 'from', 'by', 'as', 'into', 'like',
  'so', 'and', 'or', 'but', 'if', 'then', 'just', 'very', 'really', 'actually',
  'me', 'us', 'them', 'please', 'tell', 'know', 'think', 'mean'
]);

const CONTEXT_TRIGGER_RE = /\b(what|how|when|why|which|where|who|explain|describe|walk me through|tell me about|status|progress|update|timeline|deadline|milestone|roadmap|budget|cost|price|metric|kpi|number|percent|architecture|design|stack|database|backend|frontend|api|deploy|deployment|release|bug|issue|error|latency|scale|security|auth|experience|background|resume|cv|project|feature|client|deliverable|requirement|spec|document|file|slide|report)\b/i;

const CASUAL_SMALLTALK_RE = /^(how are you|how's it going|how was your weekend|nice to meet you|sounds good|let's get started|can we start|see you tomorrow|have a good weekend)[.!?]*$/i;

/**
 * Determine whether local laptop/HP document RAG should be queried for this turn.
 * @param {string} utterance
 * @param {string[]} [glossaryTerms=[]]
 * @returns {{ needsRag: boolean, query: string, reason: string }}
 */
export function evaluateContextIntent(utterance, glossaryTerms = []) {
  const clean = String(utterance || '').trim();
  if (!clean) {
    return { needsRag: false, query: '', reason: 'empty' };
  }

  if (CASUAL_SMALLTALK_RE.test(clean)) {
    return { needsRag: false, query: '', reason: 'smalltalk' };
  }

  const words = clean.split(/\s+/);
  if (words.length <= 3 && !clean.includes('?')) {
    return { needsRag: false, query: '', reason: 'too_short' };
  }

  const lower = clean.toLowerCase();
  const matchedGlossary = glossaryTerms.some(
    (term) => term && term.length >= 2 && lower.includes(term.toLowerCase())
  );

  const hasTrigger = CONTEXT_TRIGGER_RE.test(clean) || clean.includes('?');
  if (!hasTrigger && !matchedGlossary) {
    return { needsRag: false, query: '', reason: 'no_factual_intent' };
  }

  const query = extractSearchQuery(clean);
  if (!query) {
    return { needsRag: false, query: '', reason: 'no_keywords' };
  }

  return {
    needsRag: true,
    query,
    reason: matchedGlossary ? 'glossary_match' : 'question_or_domain_trigger'
  };
}

/**
 * Extract high-signal keywords for SQLite FTS5 search.
 * @param {string} utterance
 * @returns {string}
 */
export function extractSearchQuery(utterance) {
  const tokens = String(utterance || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.\-\s]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length >= 2 && !STOP_WORDS.has(tok));

  const unique = [];
  for (const tok of tokens) {
    if (!unique.includes(tok)) {
      unique.push(tok);
      if (unique.length >= 8) break;
    }
  }
  return unique.join(' ');
}
