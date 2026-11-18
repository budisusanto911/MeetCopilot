#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMeetingPrompt,
  MeetingCopilotEngine,
  TOKEN_BUDGETS,
  WaterfallAIClient
} from '../../../../packages/core-ai/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SAMPLE_CHEAT_SHEET = [
  'Project: PayFlow API v2 (Node.js + PostgreSQL + Redis)',
  'Role: Backend Engineer',
  'Key metrics: P99 latency 48ms, 99.95% uptime, Q3 migration finished Oct 15',
  'Terms: PayFlow, FTS5, NIM, WebhookRetry'
].join('\n');

const SAMPLE_MEETING_TURNS = [
  'uh-huh',
  'Hello',
  'Can you hear me?',
  'You are on mute',
  'How was your weekend?',
  'Okay',
  'Great, let us get started.',
  'What is the current P99 latency for PayFlow API v2?',
  'Nice, got it.',
  'How did you handle WebhookRetry failures during the Q3 migration?',
  'Can you explain the database caching setup?',
  'um',
  'Makes sense.',
  'What is the current P99 latency for PayFlow API v2?', // deliberate repeat -> cache hit
  'When is the next milestone scheduled for the mobile release?',
  'Thank you'
];

// Repeat conversation cycle to simulate a long 60+ turn meeting
const FULL_TRANSCRIPT = [
  ...SAMPLE_MEETING_TURNS,
  ...SAMPLE_MEETING_TURNS.map((t, i) =>
    i % 3 === 1 ? `${t} Follow-up check #${i}` : t
  ),
  ...SAMPLE_MEETING_TURNS
];

async function runAudit() {
  const capturedSystemPrefixes = new Set();
  let maxInputTokens = 0;
  let totalOutputTokens = 0;

  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    capturedSystemPrefixes.add(body.messages[0]?.content || '');

    const replyWire = [
      'T|Bagaimana status metrik dan jadwal proyek PayFlow saat ini?',
      'Q|1',
      'R1|PayFlow v2 is currently hitting 48ms P99 latency with stable uptime.',
      'R2|Our Q3 migration wrapped on October 15, and WebhookRetry uses Redis-backed exponential backoff.',
      'R3|Just to confirm, would you like the API latency figures or the mobile rollout timeline?'
    ].join('\n');

    return {
      ok: true,
      headers: { get: () => 'application/json' },
      async json() {
        return { choices: [{ message: { content: replyWire } }] };
      }
    };
  };

  const aiClient = new WaterfallAIClient({
    providers: [
      {
        id: 'nvidia',
        label: 'Mock NVIDIA NIM',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'meta/llama-3.1-8b-instruct',
        apiKey: 'mock-key',
        isLocal: false
      }
    ],
    fetchImpl: mockFetch
  });

  const engine = new MeetingCopilotEngine({
    aiClient,
    cheatSheet: SAMPLE_CHEAT_SHEET,
    glossaryTerms: ['PayFlow', 'WebhookRetry', 'Q3 migration'],
    userGoal: 'Backend Engineer Weekly Sync',
    retrieveContext: async (query) => [
      {
        source: 'architecture.md',
        snippet: `Matched (${query}): PayFlow API v2 runs on Node 20, Postgres 16, Redis Streams, P99 latency 48ms.`
      }
    ]
  });

  for (const utterance of FULL_TRANSCRIPT) {
    const out = await engine.processUtterance({ utterance });
    if (!out.skipped && out.inputTokens) {
      maxInputTokens = Math.max(maxInputTokens, out.inputTokens);
      totalOutputTokens += out.outputTokens || 0;
    }
    if (out.result?.r2) {
      engine.markUserReply(out.result.r2);
    }
  }

  // Verify buildMeetingPrompt stays bounded even when every slot is stuffed simultaneously
  const stressPrompt = buildMeetingPrompt({
    utterance: 'word '.repeat(500),
    cheatSheet: 'fact '.repeat(600),
    rollingSummary: 'summary '.repeat(300),
    userGoal: 'Backend Engineer',
    recentTurns: Array.from({ length: 8 }, (_, idx) => ({
      speaker: idx % 2 === 0 ? 'other' : 'user',
      text: 'long sentence '.repeat(80),
      reply: 'long reply '.repeat(60)
    })),
    ragSnippets: [{ source: 'big.md', snippet: 'chunk '.repeat(600) }]
  });

  const stats = engine.tracker.snapshot();
  const avgOutputTokens = stats.callsMade
    ? Math.round(totalOutputTokens / stats.callsMade)
    : 0;
  const avgInputTokens = stats.callsMade
    ? Math.round(stats.inputTokens / stats.callsMade)
    : 0;

  const checks = {
    prefixStable: capturedSystemPrefixes.size === 1,
    maxInputUnderCap: maxInputTokens <= 1100,
    stressPromptBounded: stressPrompt.estimatedInputTokens <= 1550,
    avgOutputUnderCap: avgOutputTokens <= TOKEN_BUDGETS.maxOutputTokens,
    tier0Worked: stats.skippedLocal + stats.cacheHits > 0,
    ragGatedWorked: stats.ragTriggered > 0 && stats.ragSkipped > 0
  };

  const passed = Object.values(checks).every(Boolean);
  const report = {
    passed,
    repoRoot: REPO_ROOT,
    totalUtterances: FULL_TRANSCRIPT.length,
    ...stats,
    avgInputTokens,
    maxInputTokens,
    avgOutputTokens,
    stressPromptTokens: stressPrompt.estimatedInputTokens,
    checks
  };

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = passed ? 0 : 1;
}

runAudit();
