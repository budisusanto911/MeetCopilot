/**
 * Shared provider presets and strict token-efficiency budgets.
 * All providers expose OpenAI-compatible /chat/completions endpoints.
 */

export const PROVIDER_PRESETS = Object.freeze({
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM (Free)',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    requiresKey: true,
    isLocal: false
  },
  groq: {
    id: 'groq',
    label: 'Groq (Free Fallback)',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-20b',
    requiresKey: true,
    isLocal: false
  },
  gemini: {
    id: 'gemini',
    label: 'Google AI Studio (Free Fallback)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash-lite',
    requiresKey: true,
    isLocal: false
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (Local Offline)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:3b',
    requiresKey: false,
    isLocal: true
  }
});

export const DEFAULT_WATERFALL_ORDER = Object.freeze([
  'nvidia',
  'groq',
  'gemini',
  'ollama'
]);

export const TOKEN_BUDGETS = Object.freeze({
  maxOutputTokens: 180,
  maxGlossaryTokens: 400,
  maxRagTokens: 380,
  maxSummaryTokens: 100,
  maxHistoryTurns: 4,
  maxUtteranceTokens: 200,
  firstByteTimeoutMs: 4500,
  totalRequestTimeoutMs: 12000
});
