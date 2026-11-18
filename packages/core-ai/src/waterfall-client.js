import {
  DEFAULT_WATERFALL_ORDER,
  PROVIDER_PRESETS,
  TOKEN_BUDGETS
} from './constants.js';
import { estimateTokens } from './token-estimator.js';

/**
 * Build normalized provider entries from config/env settings.
 * @param {Record<string, {enabled?: boolean, apiKey?: string, baseUrl?: string, model?: string}>} [overrides={}]
 * @param {string[]} [order=DEFAULT_WATERFALL_ORDER]
 */
export function resolveProviderChain(overrides = {}, order = DEFAULT_WATERFALL_ORDER) {
  const chain = [];
  for (const id of order) {
    const preset = PROVIDER_PRESETS[id];
    if (!preset) continue;
    const cfg = overrides[id] || {};
    if (cfg.enabled === false) continue;

    const apiKey = cfg.apiKey || '';
    if (preset.requiresKey && !apiKey) continue;

    chain.push({
      id,
      label: preset.label,
      baseUrl: (cfg.baseUrl || preset.baseUrl).replace(/\/+$/, ''),
      model: cfg.model || preset.defaultModel,
      apiKey,
      isLocal: preset.isLocal
    });
  }
  return chain;
}

/**
 * OpenAI-compatible Free Waterfall client supporting SSE streaming and automatic failover.
 */
export class WaterfallAIClient {
  /**
   * @param {object} [opts]
   * @param {Array<object>} [opts.providers=[]]
   * @param {typeof fetch} [opts.fetchImpl=globalThis.fetch]
   * @param {number} [opts.firstByteTimeoutMs]
   * @param {number} [opts.totalRequestTimeoutMs]
   */
  constructor({
    providers = [],
    fetchImpl = globalThis.fetch,
    firstByteTimeoutMs = TOKEN_BUDGETS.firstByteTimeoutMs,
    totalRequestTimeoutMs = TOKEN_BUDGETS.totalRequestTimeoutMs
  } = {}) {
    this.providers = providers;
    this.fetchImpl = fetchImpl;
    this.firstByteTimeoutMs = firstByteTimeoutMs;
    this.totalRequestTimeoutMs = totalRequestTimeoutMs;
  }

  setProviders(providers) {
    this.providers = Array.isArray(providers) ? providers : [];
  }

  /**
   * Stream chat completions across configured providers until one succeeds.
   * @param {object} params
   * @param {Array<{role: string, content: string}>} params.messages
   * @param {number} [params.maxTokens=TOKEN_BUDGETS.maxOutputTokens]
   * @param {number} [params.temperature=0.25]
   * @param {(delta: string, providerId: string) => void} [params.onDelta]
   * @param {(attempt: object) => void} [params.onAttempt]
   */
  async streamChat({
    messages,
    maxTokens = TOKEN_BUDGETS.maxOutputTokens,
    temperature = 0.25,
    onDelta,
    onAttempt
  }) {
    if (!this.providers.length) {
      throw new Error(
        'No AI providers configured. Add NVIDIA_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, or enable Ollama.'
      );
    }

    const attempts = [];
    for (const provider of this.providers) {
      const startedAt = Date.now();
      try {
        const text = await this.#callProviderWithModelRecovery(provider, {
          messages,
          maxTokens,
          temperature,
          onDelta
        });
        const attempt = {
          provider: provider.id,
          model: provider.model,
          ok: true,
          latencyMs: Date.now() - startedAt
        };
        attempts.push(attempt);
        if (onAttempt) onAttempt(attempt);

        return {
          text,
          providerUsed: provider.id,
          modelUsed: provider.model,
          latencyMs: attempt.latencyMs,
          attempts,
          estimatedOutputTokens: estimateTokens(text)
        };
      } catch (err) {
        const attempt = {
          provider: provider.id,
          model: provider.model,
          ok: false,
          status: err.status || null,
          error: err.message || String(err),
          latencyMs: Date.now() - startedAt
        };
        attempts.push(attempt);
        if (onAttempt) onAttempt(attempt);
      }
    }

    const summary = attempts.map((a) => `${a.provider}: ${a.error}`).join(' | ');
    const error = new Error(`All waterfall providers failed (${summary})`);
    error.attempts = attempts;
    throw error;
  }

  async #callProviderWithModelRecovery(provider, opts) {
    try {
      return await this.#callProviderStream(provider, opts);
    } catch (err) {
      if (err.status !== 404 && err.status !== 410) throw err;
      const discovered = await this.#discoverActiveModel(provider);
      if (!discovered || discovered === provider.model) throw err;
      provider.model = discovered;
      return this.#callProviderStream(provider, opts);
    }
  }

  async #discoverActiveModel(provider) {
    try {
      const headers = {};
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      const res = await this.fetchImpl(`${provider.baseUrl}/models`, { headers });
      if (!res.ok) return null;
      const data = await res.json();
      const nonChatRe = /(embed|rerank|guard|safety|whisper|orpheus|tts|parse|vision|vl-|audio)/i;
      const candidates = (data?.data || [])
        .map((m) => m?.id)
        .filter((id) => typeof id === 'string' && !nonChatRe.test(id));

      return (
        candidates.find((id) => /(nemotron|llama|qwen|gpt-oss|gemma)/i.test(id)) ||
        candidates[0] ||
        null
      );
    } catch {
      return null;
    }
  }

  async #callProviderStream(provider, { messages, maxTokens, temperature, onDelta }) {
    const controller = new AbortController();
    let gotFirstByte = false;

    const firstByteTimer = setTimeout(() => {
      if (!gotFirstByte) controller.abort(new Error(`First-byte timeout (${this.firstByteTimeoutMs}ms)`));
    }, this.firstByteTimeoutMs);

    const totalTimer = setTimeout(() => {
      controller.abort(new Error(`Total request timeout (${this.totalRequestTimeoutMs}ms)`));
    }, this.totalRequestTimeoutMs);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (provider.apiKey) {
        headers.Authorization = `Bearer ${provider.apiKey}`;
      }

      const payload = {
        model: provider.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true
      };
      // Disable slow reasoning/thinking tokens on NVIDIA Nemotron/Qwen during live meetings
      if (provider.id === 'nvidia') {
        payload.chat_template_kwargs = { enable_thinking: false };
      }

      const res = await this.fetchImpl(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        clearTimeout(firstByteTimer);
        const errBody = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 140)}` : ''}`);
        err.status = res.status;
        throw err;
      }

      const markFirstByte = () => {
        if (!gotFirstByte) {
          gotFirstByte = true;
          clearTimeout(firstByteTimer);
        }
      };

      const contentType = res.headers?.get?.('content-type') || '';
      if (!res.body || contentType.includes('application/json')) {
        markFirstByte();
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content || '';
        if (!text.trim()) throw new Error('Empty JSON completion');
        if (onDelta) onDelta(text, provider.id);
        return text;
      }

      const text = await this.#consumeSseStream(res.body, (delta) => {
        markFirstByte();
        if (onDelta) onDelta(delta, provider.id);
      });
      markFirstByte();
      if (!text.trim()) {
        throw new Error('Empty SSE stream response');
      }
      return text;
    } finally {
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
    }
  }

  async #consumeSseStream(body, onDelta) {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';

    const processLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;

      try {
        const parsed = JSON.parse(payload);
        const delta =
          parsed?.choices?.[0]?.delta?.content ??
          parsed?.choices?.[0]?.message?.content ??
          '';
        if (delta) {
          fullText += delta;
          onDelta(delta);
        }
      } catch {
        // Ignore malformed keepalive/partial JSON lines
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        processLine(buffer.slice(0, newlineIdx));
        buffer = buffer.slice(newlineIdx + 1);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      processLine(buffer);
    }

    return fullText;
  }
}
