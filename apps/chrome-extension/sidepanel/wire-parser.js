/**
 * Lightweight wire-format parser & Chrome Built-in LanguageModel fallback helper
 * for the Chrome Extension Side Panel (self-contained for MV3 unpacked loading).
 */

const WIRE_LINE_RE = /^(T|Q|R1|R2|R3)\s*[:|]\s*(.*)$/i;

export function parseWireOutput(rawText) {
  const cleaned = String(rawText || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/```$/gm, '');

  const out = { t: '', q: false, r1: '', r2: '', r3: '' };
  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(WIRE_LINE_RE);
    if (!match) continue;
    const key = match[1].toUpperCase();
    const val = match[2].trim();
    if (key === 'T') out.t = val;
    else if (key === 'Q') out.q = val === '1' || /^true|yes$/i.test(val);
    else if (key === 'R1') out.r1 = val;
    else if (key === 'R2') out.r2 = val;
    else if (key === 'R3') out.r3 = val;
  }

  if (!out.t && cleaned.trim()) {
    out.t = cleaned.trim();
  }
  return out;
}

/**
 * Fallback to Chrome Built-in Prompt API (Gemini Nano) if Local Bridge is offline.
 * @param {string} utterance
 * @param {string} cheatSheet
 * @param {(partial: object) => void} [onPartial]
 */
export async function runChromeNanoFallback(utterance, cheatSheet = '', onPartial) {
  if (!globalThis.LanguageModel) {
    throw new Error('Local Bridge offline dan Chrome Built-in AI (LanguageModel) tidak tersedia.');
  }

  const availability = await globalThis.LanguageModel.availability({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }]
  });
  if (availability === 'unavailable') {
    throw new Error('Chrome Built-in AI tidak tersedia di perangkat ini.');
  }

  const systemPrompt = [
    'You are MeetCopilot. Translate English to natural Indonesian and give 3 concise English replies.',
    'Output EXACTLY 5 lines:',
    'T|<Indonesian translation>',
    'Q|<1 or 0>',
    'R1|<short direct English reply>',
    'R2|<detailed English reply>',
    'R3|<polite clarifying English reply>',
    cheatSheet ? `Context:\n${cheatSheet.slice(0, 1200)}` : ''
  ].filter(Boolean).join('\n');

  const session = await globalThis.LanguageModel.create({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
    initialPrompts: [{ role: 'system', content: systemPrompt }]
  });

  try {
    let accumulated = '';
    for await (const chunk of session.promptStreaming(`U: ${utterance}`)) {
      accumulated += chunk;
      if (onPartial) onPartial(parseWireOutput(accumulated));
    }
    return parseWireOutput(accumulated);
  } finally {
    session.destroy();
  }
}
