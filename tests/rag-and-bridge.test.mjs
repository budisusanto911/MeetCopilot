import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createBridgeServer } from '../apps/local-bridge/src/server.mjs';
import { LocalRagBridge } from '../apps/local-bridge/src/rag-bridge.mjs';

const execFileAsync = promisify(execFile);

/**
 * Helper to create a valid minimal .docx archive using Python zipfile for offline test.
 */
async function createTestDocx(targetPath, paragraphText) {
  const py = [
    'import sys, zipfile',
    'xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>{sys.argv[2]}</w:t></w:r></w:p></w:body></w:document>"""',
    'with zipfile.ZipFile(sys.argv[1], "w") as z: z.writestr("word/document.xml", xml)'
  ].join('\n');
  await execFileAsync('python3', ['-c', py, targetPath, paragraphText]);
}

function encodeClientTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) {
    masked[i] ^= mask[i % 4];
  }
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, mask, masked]);
}

test('LocalRagBridge indexes MD/DOCX, enforces token cap, and blocks .env/.key secrets', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetcopilot-rag-'));
  const docsDir = path.join(tmpDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });

  fs.writeFileSync(
    path.join(docsDir, 'architecture.md'),
    '# PayFlow Architecture\n\nPayFlow API uses Redis Streams for WebhookRetry with 48ms P99 latency.\n'
  );
  await createTestDocx(
    path.join(docsDir, 'roadmap.docx'),
    'Q4 Mobile Companion launches on November 30 with offline SQLite vault.'
  );

  // Sensitive files that MUST be ignored
  fs.writeFileSync(path.join(docsDir, '.env'), 'TOP_SECRET_PASSWORD=super_secret_env_value\n');
  fs.writeFileSync(path.join(docsDir, 'prod.key'), 'PRIVATE_RSA_KEY_MATERIAL_SHOULD_NOT_INDEX\n');
  fs.writeFileSync(path.join(docsDir, 'release.keystore'), 'ANDROID_KEYSTORE_SECRET_MATERIAL\n');
  fs.writeFileSync(path.join(docsDir, 'service-account.json'), '{"private_key":"GCP_SA_SECRET"}\n');

  const dbPath = path.join(tmpDir, 'vault.sqlite');
  const rag = new LocalRagBridge(dbPath);

  try {
    const idxRes = await rag.indexPaths([docsDir]);
    assert.equal(idxRes.ok, true);
    assert.equal(idxRes.totalDocs, 2);

    const hitRes = await rag.query('PayFlow WebhookRetry latency', 120, 3);
    assert.ok(hitRes.snippets.length >= 1);
    assert.match(hitRes.snippets[0].snippet, /WebhookRetry/i);
    assert.ok(hitRes.usedTokens <= 120);

    const docxHit = await rag.query('Mobile Companion offline SQLite', 120, 3);
    assert.ok(docxHit.snippets.some((s) => /November 30/i.test(s.snippet)));

    // Assert secrets were never indexed
    const envCheck = await rag.query('super_secret_env_value PRIVATE_RSA_KEY_MATERIAL ANDROID_KEYSTORE_SECRET_MATERIAL GCP_SA_SECRET', 200, 5);
    assert.equal(envCheck.snippets.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('LocalBridge HTTP, glossary packer, SSE streaming, auth, and WebSocket work end-to-end', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetcopilot-bridge-'));
  const docsDir = path.join(tmpDir, 'project');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(
    path.join(docsDir, 'notes.md'),
    '# NexusSync Project\n- P99 latency is 35ms after FTS5 optimization.\n- Deployment uses Docker Compose.\n'
  );

  // Mock NVIDIA NIM SSE server + Groq Whisper STT server
  let lastUpstreamPrompt = '';
  const mockNvidia = http.createServer(async (req, res) => {
    if (req.url === '/audio/transcriptions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'What is the NexusSync latency?' }));
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    lastUpstreamPrompt = JSON.stringify(body.messages);

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"T|Berapa latensi NexusSync sekarang?\\n"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"Q|1\\nR1|P99 latency is currently 35ms.\\n"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"R2|After our FTS5 optimization, NexusSync P99 latency dropped to 35ms.\\nR3|Are you checking prod or staging metrics?"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });

  await new Promise((resolve) => mockNvidia.listen(0, '127.0.0.1', resolve));
  const mockPort = mockNvidia.address().port;

  const bridge = createBridgeServer({
    rootDir: tmpDir,
    configOverrides: {
      host: '127.0.0.1',
      port: 0,
      pairToken: 'test-pair-secret',
      providers: {
        nvidia: {
          enabled: true,
          apiKey: 'nv-mock-key',
          model: 'meta/llama-3.1-8b-instruct',
          baseUrl: `http://127.0.0.1:${mockPort}`
        },
        groq: { enabled: false, apiKey: 'gq-mock-stt', baseUrl: `http://127.0.0.1:${mockPort}` },
        gemini: { enabled: false, apiKey: '' },
        ollama: { enabled: false, apiKey: '' }
      }
    }
  });

  const { port } = await bridge.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders = {
    'Content-Type': 'application/json',
    'X-Pair-Token': 'test-pair-secret'
  };

  try {
    // 1. Auth rejects missing token
    const unauth = await fetch(`${baseUrl}/health`);
    assert.equal(unauth.status, 401);

    // 2. Health masks API key
    const healthRes = await fetch(`${baseUrl}/health`, { headers: authHeaders });
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.activeChain[0].id, 'nvidia');
    assert.equal(health.providers[0].hasApiKey, true);
    assert.equal(health.providers[0].apiKey, undefined);

    // 3. Index docs + pack glossary
    const idxRes = await fetch(`${baseUrl}/api/context/index`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ paths: [docsDir] })
    });
    assert.equal((await idxRes.json()).totalDocs, 1);

    const packRes = await fetch(`${baseUrl}/api/context/pack-glossary`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ paths: [docsDir], maxTokens: 300, userGoal: 'Lead Dev' })
    });
    const packed = await packRes.json();
    assert.equal(packed.ok, true);
    assert.ok(packed.estimatedTokens <= 300);
    assert.match(packed.cheatSheet, /NexusSync/i);

    // 4. Streaming SSE translate-reply uses RAG + cheat sheet
    const sseRes = await fetch(`${baseUrl}/api/translate-reply`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ utterance: 'What is the NexusSync latency now?' })
    });
    const sseText = await sseRes.text();
    assert.match(sseText, /event: partial/);
    assert.match(sseText, /event: done/);
    assert.match(lastUpstreamPrompt, /35ms/);

    // 5. Real WebSocket client receives turn_done for utterance
    const wsPayload = await new Promise((resolve, reject) => {
      const sock = net.createConnection(port, '127.0.0.1', () => {
        const wsKey = crypto.randomBytes(16).toString('base64');
        sock.write(
          [
            'GET /ws?token=test-pair-secret HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${wsKey}`,
            'Sec-WebSocket-Version: 13',
            '\r\n'
          ].join('\r\n')
        );
      });

      let upgraded = false;
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          upgraded = true;
          buf = buf.subarray(idx + 4);
          sock.write(
            encodeClientTextFrame(
              JSON.stringify({ type: 'utterance', id: 'u-1', utterance: 'Can you hear me?' })
            )
          );
          return;
        }
        // Parse all unmasked server text frames in buffer until turn_done
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            off = 4;
          }
          if (buf.length < off + len) break;
          const text = buf.subarray(off, off + len).toString('utf8');
          buf = buf.subarray(off + len);
          const msg = JSON.parse(text);
          if (msg.type === 'turn_done') {
            sock.destroy();
            resolve(msg);
            return;
          }
        }
      });
      sock.on('error', reject);
    });

    assert.equal(wsPayload.type, 'turn_done');
    assert.equal(wsPayload.providerUsed, 'tier0-phrase');
    assert.match(wsPayload.result.t, /Suara/i);

    // 6. VAD audio segment STT -> translate-reply pipeline
    const sttRes = await fetch(`${baseUrl}/api/stt`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        audioBase64: Buffer.from('mock-webm-audio').toString('base64'),
        mimeType: 'audio/webm'
      })
    });
    const sttData = await sttRes.json();
    assert.equal(sttData.ok, true);
    assert.equal(sttData.transcript, 'What is the NexusSync latency?');
    assert.match(sttData.result.r1, /35ms/);
  } finally {
    await bridge.stop();
    await new Promise((resolve) => mockNvidia.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
