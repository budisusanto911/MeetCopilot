/**
 * Tier-0 utterance filter, zero-token common meeting phrase map, and LRU response cache.
 */

const NOISE_FILLERS = new Set([
  'uh', 'um', 'umm', 'uhh', 'hmm', 'hm', 'er', 'erm', 'ah', 'oh',
  'uh huh', 'uh-huh', 'mm hmm', 'mm-hmm', 'mhm', 'huh', 'yeah yeah'
]);

/**
 * Common short meeting phrases resolved instantly at 0 LLM tokens.
 */
const INSTANT_PHRASE_MAP = new Map([
  ['hello', { t: 'Halo.', q: true, r1: 'Hi everyone, good to be here.', r2: 'Hi! Thanks for having me, can you hear me clearly?', r3: 'Hello! Just checking if my audio is coming through okay.' }],
  ['hi', { t: 'Hai.', q: true, r1: 'Hi there!', r2: 'Hi! Good to see you today.', r3: 'Hey, thanks for joining.' }],
  ['good morning', { t: 'Selamat pagi.', q: true, r1: 'Good morning!', r2: 'Good morning everyone, thanks for making time today.', r3: 'Morning! How is everything going on your end?' }],
  ['good afternoon', { t: 'Selamat siang/sore.', q: true, r1: 'Good afternoon!', r2: 'Good afternoon everyone, great to connect today.', r3: 'Afternoon! Ready whenever you are.' }],
  ['can you hear me', { t: 'Suara saya kedengaran?', q: true, r1: 'Yes, I can hear you loud and clear.', r2: 'Yes, your audio is clear on my side. How about mine?', r3: 'I can hear you, though it is a little faint—could you speak slightly closer to the mic?' }],
  ['you are on mute', { t: 'Mikrofon kamu masih mute.', q: true, r1: 'Oh sorry, let me unmute myself.', r2: 'Thanks for flagging! Can you hear me now?', r3: 'Oops, my bad—I am unmuted now.' }],
  ['youre on mute', { t: 'Mikrofon kamu masih mute.', q: true, r1: 'Oh sorry, let me unmute myself.', r2: 'Thanks for flagging! Can you hear me now?', r3: 'Oops, my bad—I am unmuted now.' }],
  ['thank you', { t: 'Terima kasih.', q: false, r1: "You're welcome!", r2: 'Happy to help—let me know if you need anything else.', r3: 'Anytime!' }],
  ['thanks', { t: 'Makasih.', q: false, r1: 'No problem!', r2: 'Glad that helped.', r3: 'Sure thing!' }],
  ['okay', { t: 'Oke.', q: false, r1: 'Sounds good.', r2: 'Got it, makes sense.', r3: 'Great, let us proceed.' }],
  ['got it', { t: 'Siap, paham.', q: false, r1: 'Great.', r2: 'Awesome, glad we are aligned.', r3: 'Sounds good, feel free to continue.' }],
  ['makes sense', { t: 'Masuk akal / paham.', q: false, r1: 'Glad to hear that.', r2: 'Great, let me know if you want me to expand on any part.', r3: 'Awesome, shall we move to the next point?' }],
  ['next slide', { t: 'Lanjut ke slide berikutnya.', q: false, r1: 'Moving to the next slide now.', r2: 'Sure, jumping to the next slide.', r3: 'One second while I switch slides.' }]
]);

/**
 * Normalize text for reliable matching and caching.
 * @param {string} text
 * @returns {string}
 */
export function normalizeUtterance(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toLookupKey(text) {
  return normalizeUtterance(text)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Evaluate whether an utterance can be dropped or handled locally with 0 LLM tokens.
 * @param {string} rawText
 * @returns {{ action: 'drop'|'instant'|'llm', text: string, reason?: string, result?: object }}
 */
export function evaluateTier0Utterance(rawText) {
  const text = normalizeUtterance(rawText);
  if (!text) {
    return { action: 'drop', text: '', reason: 'empty' };
  }

  const key = toLookupKey(text);
  if (!key || NOISE_FILLERS.has(key) || key.length < 2) {
    return { action: 'drop', text, reason: 'noise_filler' };
  }

  const instant = INSTANT_PHRASE_MAP.get(key);
  if (instant) {
    return {
      action: 'instant',
      text,
      reason: 'instant_phrase',
      result: { ...instant, source: 'tier0-phrase' }
    };
  }

  return { action: 'llm', text };
}

/**
 * Bounded LRU cache for repeated meeting utterances.
 */
export class PhraseCache {
  /**
   * @param {number} [maxEntries=200]
   */
  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  /**
   * @param {string} utterance
   * @param {string} [contextKey='']
   * @returns {object|null}
   */
  get(utterance, contextKey = '') {
    const key = `${contextKey}::${toLookupKey(utterance)}`;
    if (!this.map.has(key)) return null;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return { ...val, source: 'tier0-cache' };
  }

  /**
   * @param {string} utterance
   * @param {object} result
   * @param {string} [contextKey='']
   */
  set(utterance, result, contextKey = '') {
    if (!utterance || !result?.t) return;
    const key = `${contextKey}::${toLookupKey(utterance)}`;
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.map.set(key, {
      t: result.t,
      q: Boolean(result.q),
      r1: result.r1 || '',
      r2: result.r2 || '',
      r3: result.r3 || ''
    });
  }
}
