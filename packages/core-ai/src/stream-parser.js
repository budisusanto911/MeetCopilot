/**
 * Incremental streaming parser for compact delimited wire lines:
 * T|<translation>, Q|<0|1>, R1|<reply1>, R2|<reply2>, R3|<reply3>
 */

const LINE_RE = /^(T|Q|R1|R2|R3)\s*[:|]\s*(.*)$/i;

/**
 * Create a stateful incremental parser for streamed LLM output.
 * @param {(snapshot: {t: string, q: boolean, r1: string, r2: string, r3: string, raw: string}) => void} [onUpdate]
 */
export function createStreamParser(onUpdate) {
  let raw = '';
  const state = { t: '', q: false, r1: '', r2: '', r3: '' };

  function parseCleanText(text) {
    // Strip optional reasoning tags or markdown fences if a model emits them
    const cleaned = text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*$/gi, '')
      .replace(/^```[^\n]*\n?/gm, '')
      .replace(/```$/gm, '');

    const next = { t: '', q: false, r1: '', r2: '', r3: '' };
    const lines = cleaned.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(LINE_RE);
      if (!match) continue;

      const key = match[1].toUpperCase();
      const value = match[2].trim();
      if (key === 'T') next.t = value;
      else if (key === 'Q') next.q = value === '1' || /^true|yes$/i.test(value);
      else if (key === 'R1') next.r1 = value;
      else if (key === 'R2') next.r2 = value;
      else if (key === 'R3') next.r3 = value;
    }

    return next;
  }

  return {
    /**
     * Feed a newly arrived delta chunk.
     * @param {string} delta
     */
    push(delta) {
      if (!delta) return this.snapshot();
      raw += delta;
      const parsed = parseCleanText(raw);
      const changed =
        parsed.t !== state.t ||
        parsed.q !== state.q ||
        parsed.r1 !== state.r1 ||
        parsed.r2 !== state.r2 ||
        parsed.r3 !== state.r3;

      Object.assign(state, parsed);
      if (changed && onUpdate) {
        onUpdate(this.snapshot());
      }
      return this.snapshot();
    },

    snapshot() {
      return { ...state, raw };
    },

    finalize() {
      const parsed = parseCleanText(raw);
      Object.assign(state, parsed);
      // Graceful fallback if model ignored wire prefix completely
      if (!state.t && raw.trim()) {
        state.t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      }
      return this.snapshot();
    }
  };
}
