import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  buildMeetingPrompt,
  createStreamParser,
  estimateTokens,
  evaluateContextIntent,
  evaluateTier0Utterance,
  MeetingCopilotEngine,
  PhraseCache,
  resolveProviderChain,
  RollingMemory,
  truncateToTokenBudget,
  WaterfallAIClient
} from '../packages/core-ai/src/index.js';

test('token estimator and truncation stay within word boundaries and budgets', () => {
  assert.equal(estimateTokens(''), 0);
  const longText = 'Latency dropped from 180ms to 48ms after deploying Redis caching across three availability zones.';
  const truncated = truncateToTokenBudget(longText, 8);
  assert.ok(truncated.endsWith('...'));
  assert.ok(estimateTokens(truncated) <= 10);
});

test('Tier-0 filter drops noise fillers and resolves common phrases at 0 tokens', () => {
  assert.equal(evaluateTier0Utterance('   ').action, 'drop');
  assert.equal(evaluateTier0Utterance('uh-huh').action, 'drop');

  const mute = evaluateTier0Utterance("You're on mute!");
  assert.equal(mute.action, 'instant');
  assert.match(mute.result.t, /mute/i);
  assert.ok(mute.result.r1.length > 0);

  const tech = evaluateTier0Utterance('What is our target latency for the checkout API?');
  assert.equal(tech.action, 'llm');
});

test('PhraseCache performs LRU hit and eviction properly', () => {
  const cache = new PhraseCache(2);
  cache.set('How is the release?', { t: 'Gimana rilisnya?', q: true, r1: 'On track.' });
  cache.set('Any blockers today?', { t: 'Ada kendala hari ini?', q: true, r1: 'None.' });
  assert.ok(cache.get('How is the release?'));
  cache.set('Third unique utterance', { t: 'Ketiga', q: false, r1: 'Okay.' });
  assert.equal(cache.get('Any blockers today?'), null);
  assert.ok(cache.get('How is the release?'));
});

test('Intent gate skips casual smalltalk and triggers on factual/glossary questions', () => {
  const casual = evaluateContextIntent('How was your weekend?', ['PayFlow']);
  assert.equal(casual.needsRag, false);

  const shortAck = evaluateContextIntent('Sounds really good');
  assert.equal(shortAck.needsRag, false);

  const projectQ = evaluateContextIntent('Can you share the PayFlow status and architecture?', ['PayFlow']);
  assert.equal(projectQ.needsRag, true);
  assert.match(projectQ.query, /payflow/i);
  assert.match(projectQ.query, /architecture/i);
});

test('RollingMemory caps recent turns and compresses older turns into summary', () => {
  const mem = new RollingMemory({ maxTurns: 2, maxSummaryTokens: 60 });
  mem.addTurn({ speaker: 'other', text: 'First question about API auth' });
  mem.markLastReply('We use JWT.');
  mem.addTurn({ speaker: 'other', text: 'Second question about database' });
  mem.addTurn({ speaker: 'other', text: 'Third question about timeline' });

  const ctx = mem.getContext();
  assert.equal(ctx.recentTurns.length, 2);
  assert.match(ctx.rollingSummary, /API auth/i);
  assert.match(ctx.rollingSummary, /JWT/);
});

test('Stream parser incrementally extracts T|Q|R1|R2|R3 across fragmented chunks and strips think tags', () => {
  const updates = [];
  const parser = createStreamParser((snap) => updates.push(snap));

  parser.push('<think>internal reasoning</think>\nT|Kapan rilis ');
  parser.push('fitur barunya?\nQ|1\nR1|We ship on Friday.\n');
  parser.push('R2|Everything passed QA and deploys Friday.\nR3|Are you asking about web or mobile?');

  const final = parser.finalize();
  assert.equal(final.t, 'Kapan rilis fitur barunya?');
  assert.equal(final.q, true);
  assert.equal(final.r1, 'We ship on Friday.');
  assert.equal(final.r2, 'Everything passed QA and deploys Friday.');
  assert.equal(final.r3, 'Are you asking about web or mobile?');
  assert.ok(updates.length >= 2);
});

test('WaterfallAIClient seamlessly fails over from 429 and timeout to healthy fallback SSE stream', async () => {
  const mockServer = http.createServer((req, res) => {
    if (req.url.startsWith('/nvidia/')) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }
    if (req.url.startsWith('/groq/')) {
      // Deliberately stall longer than firstByteTimeoutMs
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200);
          res.end();
        }
      }, 400);
      return;
    }
    if (req.url.startsWith('/gemini/')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"T|Status rilis aman.\\n"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Q|1\\nR1|On track.\\nR2|On track for Friday.\\nR3|Need more details?"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    }
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const { port } = mockServer.address();

  try {
    const chain = resolveProviderChain(
      {
        nvidia: { apiKey: 'nv-test', baseUrl: `http://127.0.0.1:${port}/nvidia` },
        groq: { apiKey: 'gq-test', baseUrl: `http://127.0.0.1:${port}/groq` },
        gemini: { apiKey: 'gm-test', baseUrl: `http://127.0.0.1:${port}/gemini` }
      },
      ['nvidia', 'groq', 'gemini']
    );

    const client = new WaterfallAIClient({
      providers: chain,
      firstByteTimeoutMs: 120,
      totalRequestTimeoutMs: 2000
    });

    const engine = new MeetingCopilotEngine({ aiClient: client });
    const partials = [];
    const out = await engine.processUtterance({
      utterance: 'What is the release status?',
      onPartial: (p) => partials.push(p)
    });

    assert.equal(out.skipped, false);
    assert.equal(out.providerUsed, 'gemini');
    assert.equal(out.attempts.length, 3);
    assert.equal(out.attempts[0].status, 429);
    assert.equal(out.attempts[1].ok, false);
    assert.equal(out.result.t, 'Status rilis aman.');
    assert.equal(out.result.r2, 'On track for Friday.');
    assert.ok(partials.length >= 1);
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
  }
});

test('buildMeetingPrompt keeps immutable system prefix and bounds dynamic payload', () => {
  const p1 = buildMeetingPrompt({
    utterance: 'First question',
    cheatSheet: 'Project: MeetCopilot',
    userGoal: 'Tech Lead'
  });
  const p2 = buildMeetingPrompt({
    utterance: 'Second question',
    cheatSheet: 'Project: MeetCopilot',
    userGoal: 'Tech Lead',
    rollingSummary: 'Earlier discussed latency',
    ragSnippets: [{ source: 'spec.md', snippet: 'Target P99 is 50ms.' }]
  });
  assert.equal(p1.messages[0].content, p2.messages[0].content);
});

test('WaterfallAIClient auto-discovers active model when configured model returns 410 Gone', async () => {
  const mockServer = http.createServer(async (req, res) => {
    if (req.url === '/nvidia/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            { id: 'nvidia/nemotron-3-embed-1b' },
            { id: 'nvidia/nemotron-3-ultra-550b-a55b' }
          ]
        })
      );
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.model === 'retired/old-model') {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Model reached end of life' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'T|Halo!\nQ|1\nR1|Hi!\nR2|Hello everyone!\nR3|Can you hear me?' } }]
      })
    );
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const { port } = mockServer.address();

  try {
    const client = new WaterfallAIClient({
      providers: [
        {
          id: 'nvidia',
          label: 'Mock NVIDIA',
          baseUrl: `http://127.0.0.1:${port}/nvidia`,
          model: 'retired/old-model',
          apiKey: 'nv-mock',
          isLocal: false
        }
      ]
    });

    const out = await client.streamChat({
      messages: [{ role: 'user', content: 'U: Hello there' }]
    });
    assert.equal(out.providerUsed, 'nvidia');
    assert.equal(out.modelUsed, 'nvidia/nemotron-3-ultra-550b-a55b');
    assert.match(out.text, /T\|Halo!/);
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
  }
});
