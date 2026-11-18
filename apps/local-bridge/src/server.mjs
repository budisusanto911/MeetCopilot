import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  MeetingCopilotEngine,
  resolveProviderChain,
  WaterfallAIClient
} from '../../../packages/core-ai/src/index.js';
import {
  getMaskedProviders,
  loadBridgeConfig,
  saveBridgeSettings
} from './config.mjs';
import { LocalRagBridge } from './rag-bridge.mjs';
import { WebSocketHub } from './ws.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PACKER_SCRIPT = path.join(
  REPO_ROOT,
  '.agents/skills/meeting-glossary-packer/scripts/pack_glossary.py'
);

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Pair-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error('Request payload too large');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

/**
 * Create the MeetCopilot Local Bridge server (HTTP + SSE + WebSocket).
 * @param {object} [opts]
 * @param {string} [opts.rootDir]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {object} [opts.configOverrides]
 */
export function createBridgeServer({
  rootDir = REPO_ROOT,
  fetchImpl = globalThis.fetch,
  configOverrides = {}
} = {}) {
  const config = { ...loadBridgeConfig(rootDir), ...configOverrides };
  if (configOverrides.providers) {
    config.providers = configOverrides.providers;
  }

  const rag = new LocalRagBridge(config.dbPath);
  const wsHub = new WebSocketHub();

  const buildChain = () =>
    resolveProviderChain(config.providers, config.waterfallOrder);

  const aiClient = new WaterfallAIClient({
    providers: buildChain(),
    fetchImpl
  });

  const engine = new MeetingCopilotEngine({
    aiClient,
    retrieveContext: async (query, maxTokens) => {
      const res = await rag.query(query, maxTokens, 3);
      return res?.snippets || [];
    }
  });

  function authorizeRequest(req, parsedUrl) {
    if (!config.pairToken && isLoopbackHost(config.host)) return true;
    if (!config.pairToken) return false;
    const token =
      req.headers['x-pair-token'] ||
      parsedUrl.searchParams.get('token') ||
      '';
    return token === config.pairToken;
  }

  async function runTurn(payload, onPartial) {
    const out = await engine.processUtterance({
      utterance: payload.utterance,
      speaker: payload.speaker || 'other',
      forceDeepContext: Boolean(payload.forceDeepContext),
      onPartial
    });
    return out;
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Pair-Token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (!authorizeRequest(req, parsedUrl)) {
      sendJson(res, 401, { ok: false, error: 'Invalid or missing X-Pair-Token' });
      return;
    }

    try {
      if (req.method === 'GET' && parsedUrl.pathname === '/health') {
        const stats = await rag.stats();
        sendJson(res, 200, {
          ok: true,
          service: 'meetcopilot-local-bridge',
          activeChain: buildChain().map((p) => ({ id: p.id, model: p.model })),
          providers: getMaskedProviders(config),
          rag: stats,
          tokens: engine.tracker.snapshot()
        });
        return;
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/api/settings/providers') {
        sendJson(res, 200, {
          ok: true,
          waterfallOrder: config.waterfallOrder,
          providers: getMaskedProviders(config)
        });
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/settings/providers') {
        const body = await readJsonBody(req);
        if (Array.isArray(body.waterfallOrder)) {
          config.waterfallOrder = body.waterfallOrder;
        }
        if (body.providers && typeof body.providers === 'object') {
          for (const [id, patch] of Object.entries(body.providers)) {
            if (!config.providers[id]) continue;
            config.providers[id] = { ...config.providers[id], ...patch };
          }
        }
        aiClient.setProviders(buildChain());
        if (body.persist !== false) {
          saveBridgeSettings(config);
        }
        sendJson(res, 200, {
          ok: true,
          activeChain: buildChain().map((p) => ({ id: p.id, model: p.model })),
          providers: getMaskedProviders(config)
        });
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/meeting/profile') {
        const body = await readJsonBody(req);
        engine.setMeetingProfile({
          cheatSheet: body.cheatSheet || '',
          glossaryTerms: Array.isArray(body.glossaryTerms) ? body.glossaryTerms : [],
          userGoal: body.userGoal || ''
        });
        if (body.resetSession) {
          engine.resetSession();
        }
        sendJson(res, 200, { ok: true, tokens: engine.tracker.snapshot() });
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/meeting/mark-reply') {
        const body = await readJsonBody(req);
        engine.markUserReply(body.reply || '');
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/meeting/reset') {
        engine.resetSession();
        sendJson(res, 200, { ok: true, tokens: engine.tracker.snapshot() });
        return;
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/api/context/stats') {
        const stats = await rag.stats();
        sendJson(res, 200, stats);
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/context/index') {
        const body = await readJsonBody(req);
        const dirs = Array.isArray(body.paths) ? body.paths : config.allowedDirs;
        const result = await rag.indexPaths(dirs);
        if (body.rememberDirs) {
          config.allowedDirs = dirs;
          saveBridgeSettings(config);
        }
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/context/query') {
        const body = await readJsonBody(req);
        const result = await rag.query(
          body.query || '',
          Number(body.maxTokens || 420),
          Number(body.limit || 3)
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/context/clear') {
        const result = await rag.clear();
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/context/pack-glossary') {
        const body = await readJsonBody(req);
        const paths = Array.isArray(body.paths) ? body.paths : config.allowedDirs;
        if (!paths.length) {
          sendJson(res, 400, { ok: false, error: 'paths is required' });
          return;
        }
        const maxTokens = String(Number(body.maxTokens || 450));
        const { stdout } = await execFileAsync('python3', [
          PACKER_SCRIPT,
          '--max-tokens',
          maxTokens,
          '--json',
          ...paths.map(String)
        ]);
        const packed = JSON.parse(stdout);
        if (body.applyToMeeting !== false) {
          engine.setMeetingProfile({
            cheatSheet: packed.cheatSheet,
            glossaryTerms: packed.glossaryTerms,
            userGoal: body.userGoal || engine.userGoal
          });
        }
        sendJson(res, 200, { ok: true, ...packed });
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/stt') {
        const body = await readJsonBody(req, 6 * 1024 * 1024);
        const audioBase64 = body.audioBase64 || '';
        const mimeType = body.mimeType || 'audio/webm';
        if (!audioBase64) {
          sendJson(res, 400, { ok: false, error: 'audioBase64 is required' });
          return;
        }

        const groqCfg = config.providers.groq;
        if (!groqCfg?.apiKey) {
          sendJson(res, 400, {
            ok: false,
            error: 'GROQ_API_KEY belum diisi untuk STT Tab Audio. Aktifkan CC di Meet/Teams atau isi Groq API Key.'
          });
          return;
        }

        const audioBytes = Buffer.from(audioBase64, 'base64');
        const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
        const form = new FormData();
        form.append('file', new Blob([audioBytes], { type: mimeType }), `speech.${ext}`);
        form.append('model', body.sttModel || 'whisper-large-v3-turbo');
        if (body.language) form.append('language', body.language);

        const sttRes = await fetchImpl(`${groqCfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${groqCfg.apiKey}` },
          body: form
        });
        if (!sttRes.ok) {
          const errText = await sttRes.text().catch(() => '');
          sendJson(res, 502, { ok: false, error: `STT HTTP ${sttRes.status}: ${errText.slice(0, 140)}` });
          return;
        }
        const sttData = await sttRes.json();
        const transcript = (sttData.text || '').trim();
        if (!transcript) {
          sendJson(res, 200, { ok: true, skipped: true, transcript: '' });
          return;
        }

        const id = body.id || `stt-${Date.now()}`;
        const out = await runTurn({ utterance: transcript, speaker: body.speaker || 'other' }, (partial) => {
          wsHub.broadcast({ type: 'turn_partial', id, partial });
        });
        wsHub.broadcast({ type: 'turn_done', id, ...out });
        sendJson(res, 200, { ok: true, transcript, ...out });
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/translate-reply') {
        const body = await readJsonBody(req);
        const wantsStream =
          body.stream !== false && parsedUrl.searchParams.get('stream') !== 'false';

        if (!wantsStream) {
          const out = await runTurn(body);
          wsHub.broadcast({ type: 'turn_done', ...out });
          sendJson(res, 200, { ok: true, ...out });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        const sendEvent = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        const out = await runTurn(body, (partial) => {
          sendEvent('partial', partial);
          wsHub.broadcast({ type: 'turn_partial', partial });
        });
        sendEvent('done', out);
        wsHub.broadcast({ type: 'turn_done', ...out });
        res.end();
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: err.message || String(err) });
      } else {
        res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
    }
  });

  server.on('upgrade', (req, socket) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (parsedUrl.pathname !== '/ws' || !authorizeRequest(req, parsedUrl)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wsHub.handleUpgrade(req, socket, async (client, rawMessage) => {
      let currentId = null;
      try {
        const msg = JSON.parse(rawMessage);
        currentId = msg.id || null;
        if (msg.type === 'ping') {
          client.sendJson({ type: 'pong', ts: Date.now() });
          return;
        }
        if (msg.type === 'mark_reply') {
          engine.markUserReply(msg.reply || '');
          wsHub.broadcast({ type: 'reply_marked', reply: msg.reply || '' });
          return;
        }
        if (msg.type === 'utterance') {
          const id = msg.id || String(Date.now());
          currentId = id;
          const out = await runTurn(msg, (partial) => {
            wsHub.broadcast({ type: 'turn_partial', id, partial });
          });
          wsHub.broadcast({ type: 'turn_done', id, ...out });
        }
      } catch (err) {
        client.sendJson({ type: 'error', id: currentId, error: err.message || String(err) });
      }
    });
  });

  return {
    server,
    config,
    engine,
    rag,
    wsHub,
    async start() {
      if (config.allowedDirs.length > 0) {
        await rag.indexPaths(config.allowedDirs);
      }
      await new Promise((resolve) => server.listen(config.port, config.host, resolve));
      const addr = server.address();
      return { host: config.host, port: addr.port };
    },
    async stop() {
      wsHub.closeAll();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const bridge = createBridgeServer();
  const info = await bridge.start();
  console.log(
    JSON.stringify({
      status: 'listening',
      http: `http://${info.host}:${info.port}`,
      ws: `ws://${info.host}:${info.port}/ws`,
      providers: bridge.config.waterfallOrder
    })
  );
}
