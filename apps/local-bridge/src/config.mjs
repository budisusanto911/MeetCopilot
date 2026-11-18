import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_WATERFALL_ORDER,
  PROVIDER_PRESETS
} from '../../../packages/core-ai/src/index.js';

/**
 * Parse a simple .env file without external dependencies.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const result = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

/**
 * Load bridge configuration from .env.local, .env, process.env, and .vault/settings.json.
 * @param {string} rootDir
 */
export function loadBridgeConfig(rootDir) {
  const envData = {
    ...parseEnvFile(path.join(rootDir, '.env')),
    ...parseEnvFile(path.join(rootDir, '.env.local')),
    ...process.env
  };

  const vaultDir = path.join(rootDir, '.vault');
  const settingsPath = path.join(vaultDir, 'settings.json');
  let saved = {};
  if (fs.existsSync(settingsPath)) {
    try {
      saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      saved = {};
    }
  }

  const providers = {
    nvidia: {
      enabled: saved?.providers?.nvidia?.enabled ?? true,
      apiKey: saved?.providers?.nvidia?.apiKey ?? envData.NVIDIA_API_KEY ?? '',
      model: saved?.providers?.nvidia?.model ?? envData.NVIDIA_MODEL ?? PROVIDER_PRESETS.nvidia.defaultModel,
      baseUrl: saved?.providers?.nvidia?.baseUrl ?? envData.NVIDIA_BASE_URL ?? PROVIDER_PRESETS.nvidia.baseUrl
    },
    groq: {
      enabled: saved?.providers?.groq?.enabled ?? true,
      apiKey: saved?.providers?.groq?.apiKey ?? envData.GROQ_API_KEY ?? '',
      model: saved?.providers?.groq?.model ?? envData.GROQ_MODEL ?? PROVIDER_PRESETS.groq.defaultModel,
      baseUrl: saved?.providers?.groq?.baseUrl ?? envData.GROQ_BASE_URL ?? PROVIDER_PRESETS.groq.baseUrl
    },
    gemini: {
      enabled: saved?.providers?.gemini?.enabled ?? true,
      apiKey: saved?.providers?.gemini?.apiKey ?? envData.GEMINI_API_KEY ?? '',
      model: saved?.providers?.gemini?.model ?? envData.GEMINI_MODEL ?? PROVIDER_PRESETS.gemini.defaultModel,
      baseUrl: saved?.providers?.gemini?.baseUrl ?? envData.GEMINI_BASE_URL ?? PROVIDER_PRESETS.gemini.baseUrl
    },
    ollama: {
      enabled: saved?.providers?.ollama?.enabled ?? false,
      apiKey: '',
      model: saved?.providers?.ollama?.model ?? envData.OLLAMA_MODEL ?? PROVIDER_PRESETS.ollama.defaultModel,
      baseUrl: saved?.providers?.ollama?.baseUrl ?? envData.OLLAMA_URL ?? PROVIDER_PRESETS.ollama.baseUrl
    }
  };

  const allowedDirsRaw = envData.ALLOWED_CONTEXT_DIRS || '';
  const allowedDirs = saved.allowedDirs || (allowedDirsRaw
    ? allowedDirsRaw.split(',').map((d) => d.trim()).filter(Boolean)
    : []);

  return {
    rootDir,
    vaultDir,
    settingsPath,
    dbPath: path.join(vaultDir, 'context.sqlite'),
    host: envData.BRIDGE_HOST || '127.0.0.1',
    port: Number(envData.BRIDGE_PORT || 8787),
    pairToken: envData.BRIDGE_PAIR_TOKEN || saved.pairToken || '',
    waterfallOrder: saved.waterfallOrder || [...DEFAULT_WATERFALL_ORDER],
    providers,
    allowedDirs
  };
}

/**
 * Persist non-secret/runtime settings locally inside .vault/settings.json (gitignored).
 * @param {object} config
 */
export function saveBridgeSettings(config) {
  fs.mkdirSync(config.vaultDir, { recursive: true });
  const payload = {
    waterfallOrder: config.waterfallOrder,
    providers: config.providers,
    allowedDirs: config.allowedDirs,
    pairToken: config.pairToken
  };
  fs.writeFileSync(config.settingsPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/**
 * Return provider list with API keys masked for safe status/UI responses.
 * @param {object} config
 */
export function getMaskedProviders(config) {
  return Object.entries(config.providers).map(([id, cfg]) => ({
    id,
    label: PROVIDER_PRESETS[id]?.label || id,
    enabled: cfg.enabled !== false,
    hasApiKey: Boolean(cfg.apiKey),
    isLocal: Boolean(PROVIDER_PRESETS[id]?.isLocal),
    model: cfg.model,
    baseUrl: cfg.baseUrl
  }));
}
