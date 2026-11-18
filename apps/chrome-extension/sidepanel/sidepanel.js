import { runChromeNanoFallback } from './wire-parser.js';

const els = {
  bridgeBadge: document.getElementById('bridgeBadge'),
  providerBadge: document.getElementById('providerBadge'),
  tokenMeter: document.getElementById('tokenMeter'),
  vadMeter: document.getElementById('vadMeter'),
  tabLive: document.getElementById('tabLive'),
  tabSetup: document.getElementById('tabSetup'),
  panelLive: document.getElementById('panelLive'),
  panelSetup: document.getElementById('panelSetup'),
  btnToggleCapture: document.getElementById('btnToggleCapture'),
  btnToggleMic: document.getElementById('btnToggleMic'),
  btnClearFeed: document.getElementById('btnClearFeed'),
  manualForm: document.getElementById('manualForm'),
  manualInput: document.getElementById('manualInput'),
  feed: document.getElementById('feed'),
  bridgeUrl: document.getElementById('bridgeUrl'),
  pairToken: document.getElementById('pairToken'),
  selfName: document.getElementById('selfName'),
  nvidiaKey: document.getElementById('nvidiaKey'),
  nvidiaModel: document.getElementById('nvidiaModel'),
  groqKey: document.getElementById('groqKey'),
  geminiKey: document.getElementById('geminiKey'),
  ollamaEnabled: document.getElementById('ollamaEnabled'),
  btnSaveProviders: document.getElementById('btnSaveProviders'),
  userGoal: document.getElementById('userGoal'),
  contextDirs: document.getElementById('contextDirs'),
  btnIndexDocs: document.getElementById('btnIndexDocs'),
  btnPackGlossary: document.getElementById('btnPackGlossary'),
  setupStatus: document.getElementById('setupStatus')
};

const state = {
  bridgeUrl: 'http://127.0.0.1:8787',
  pairToken: '',
  cheatSheet: '',
  ws: null,
  bridgeOnline: false,
  captureActive: false,
  cardsById: new Map()
};

function switchTab(target) {
  const isLive = target === 'live';
  els.tabLive.classList.toggle('active', isLive);
  els.tabSetup.classList.toggle('active', !isLive);
  els.panelLive.classList.toggle('active', isLive);
  els.panelSetup.classList.toggle('active', !isLive);
}

els.tabLive.addEventListener('click', () => switchTab('live'));
els.tabSetup.addEventListener('click', () => switchTab('setup'));

function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (state.pairToken) headers['X-Pair-Token'] = state.pairToken;
  return headers;
}

async function bridgeFetch(path, options = {}) {
  const base = state.bridgeUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...buildHeaders(), ...(options.headers || {}) }
  });
  return res.json();
}

function setBridgeStatus(online) {
  state.bridgeOnline = online;
  els.bridgeBadge.textContent = online ? 'Bridge Online' : 'Bridge Offline';
  els.bridgeBadge.className = `badge ${online ? 'badge-online' : 'badge-offline'}`;
}

function updateTokenMeter(tokens) {
  if (!tokens) return;
  els.tokenMeter.textContent = `Token: ${tokens.totalTokens || 0} · Hemat: ${tokens.estimatedSavedTokens || 0}`;
}

function speakSlowly(text) {
  if (!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'en-US';
  utter.rate = 0.9;
  window.speechSynthesis.speak(utter);
}

function ensureFeedNotEmpty() {
  const empty = els.feed.querySelector('.empty-state');
  if (empty) empty.remove();
}

function renderCard(id, utterance) {
  ensureFeedNotEmpty();
  let card = state.cardsById.get(id);
  if (card) return card;

  const root = document.createElement('article');
  root.className = 'turn-card';
  root.innerHTML = `
    <div class="turn-source"></div>
    <div class="turn-translation">Menerjemahkan...</div>
    <div class="replies"></div>
    <div class="turn-meta">
      <span class="meta-provider">Menunggu AI...</span>
      <button class="btn btn-ghost btn-mini btn-deep" type="button">Jawab Lebih Detail (RAG)</button>
    </div>
  `;

  root.querySelector('.turn-source').textContent = utterance;
  root.querySelector('.btn-deep').addEventListener('click', () => {
    submitUtterance(utterance, { forceDeepContext: true });
  });

  els.feed.prepend(root);
  card = {
    root,
    translationEl: root.querySelector('.turn-translation'),
    repliesEl: root.querySelector('.replies'),
    metaEl: root.querySelector('.meta-provider')
  };
  state.cardsById.set(id, card);
  return card;
}

function updateCardContent(id, data, meta = {}) {
  const card = state.cardsById.get(id);
  if (!card) return;

  if (data.t) {
    card.translationEl.textContent = data.t;
  }

  const options = [
    { key: 'r1', label: 'Opsi 1 · Quick', text: data.r1 },
    { key: 'r2', label: meta.usedRag ? 'Opsi 2 · Context (Dokumen)' : 'Opsi 2 · Detail', text: data.r2 },
    { key: 'r3', label: 'Opsi 3 · Klarifikasi', text: data.r3 }
  ].filter((o) => o.text);

  card.repliesEl.innerHTML = '';
  for (const opt of options) {
    const chip = document.createElement('div');
    chip.className = 'reply-chip';

    const labelEl = document.createElement('div');
    labelEl.className = 'reply-label';
    labelEl.textContent = opt.label;

    const textEl = document.createElement('div');
    textEl.className = 'reply-text';
    textEl.textContent = opt.text;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'reply-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-secondary btn-mini';
    copyBtn.textContent = 'Salin';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(opt.text);
      copyBtn.textContent = 'Tersalin!';
      setTimeout(() => { copyBtn.textContent = 'Salin'; }, 1200);
    });

    const saidBtn = document.createElement('button');
    saidBtn.type = 'button';
    saidBtn.className = 'btn btn-ghost btn-mini';
    saidBtn.textContent = 'Sudah Dijawab';
    saidBtn.addEventListener('click', () => {
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'mark_reply', reply: opt.text }));
      } else if (state.bridgeOnline) {
        bridgeFetch('/api/meeting/mark-reply', {
          method: 'POST',
          body: JSON.stringify({ reply: opt.text })
        }).catch(() => {});
      }
      saidBtn.textContent = 'Tercatat ✓';
      saidBtn.disabled = true;
    });

    const speakBtn = document.createElement('button');
    speakBtn.type = 'button';
    speakBtn.className = 'btn btn-ghost btn-mini';
    speakBtn.textContent = '🔊';
    speakBtn.title = 'Dengar pengucapan pelan';
    speakBtn.addEventListener('click', () => speakSlowly(opt.text));

    actionsEl.append(copyBtn, saidBtn, speakBtn);
    chip.append(labelEl, textEl, actionsEl);
    card.repliesEl.append(chip);
  }

  if (meta.providerUsed) {
    const latency = typeof meta.latencyMs === 'number' ? ` · ${meta.latencyMs}ms` : '';
    const ragTag = meta.usedRag ? ' · +RAG' : '';
    card.metaEl.textContent = `${meta.providerUsed}${ragTag}${latency}`;
    els.providerBadge.textContent = meta.providerUsed;
  }
}

async function submitUtterance(utterance, { speaker = 'other', forceDeepContext = false } = {}) {
  const clean = String(utterance || '').trim();
  if (!clean) return;
  const id = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  renderCard(id, clean);

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'utterance', id, utterance: clean, speaker, forceDeepContext }));
    return;
  }

  if (state.bridgeOnline) {
    try {
      const res = await bridgeFetch('/api/translate-reply?stream=false', {
        method: 'POST',
        body: JSON.stringify({ utterance: clean, speaker, forceDeepContext, stream: false })
      });
      if (res.skipped) {
        state.cardsById.get(id)?.root.remove();
        updateTokenMeter(res.tokens);
        return;
      }
      updateCardContent(id, res.result || {}, res);
      updateTokenMeter(res.tokens);
      return;
    } catch {
      // Fallback to Chrome Built-in AI below
    }
  }

  try {
    els.providerBadge.textContent = 'chrome-nano';
    const final = await runChromeNanoFallback(clean, state.cheatSheet, (partial) => {
      updateCardContent(id, partial, { providerUsed: 'chrome-nano' });
    });
    updateCardContent(id, final, { providerUsed: 'chrome-nano' });
  } catch (err) {
    const card = state.cardsById.get(id);
    if (card) {
      card.translationEl.textContent = `Gagal memproses: ${err.message}`;
    }
  }
}

function connectWebSocket() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  const baseWs = state.bridgeUrl
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:')
    .replace(/\/+$/, '');
  const tokenQuery = state.pairToken ? `?token=${encodeURIComponent(state.pairToken)}` : '';
  const ws = new WebSocket(`${baseWs}/ws${tokenQuery}`);

  ws.addEventListener('open', async () => {
    setBridgeStatus(true);
    try {
      const health = await bridgeFetch('/health');
      updateTokenMeter(health.tokens);
      if (health.activeChain?.length) {
        els.providerBadge.textContent = health.activeChain[0].id;
      }
    } catch {
      // ignore
    }
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'turn_partial' && msg.id) {
        if (!state.cardsById.has(msg.id)) {
          renderCard(msg.id, msg.utterance || 'Mendengarkan...');
        }
        updateCardContent(msg.id, msg.partial || {});
      } else if (msg.type === 'turn_done' && msg.id) {
        if (msg.skipped) {
          state.cardsById.get(msg.id)?.root.remove();
        } else {
          if (!state.cardsById.has(msg.id)) {
            renderCard(msg.id, msg.utterance || '');
          } else if (msg.utterance) {
            const srcEl = state.cardsById.get(msg.id)?.root.querySelector('.turn-source');
            if (srcEl) srcEl.textContent = msg.utterance;
          }
          updateCardContent(msg.id, msg.result || {}, msg);
        }
        updateTokenMeter(msg.tokens);
      } else if (msg.type === 'error') {
        const errText = `Error: ${msg.error || 'Gagal memproses'}`;
        els.vadMeter.textContent = errText;
        const targetCard = msg.id ? state.cardsById.get(msg.id) : null;
        if (targetCard) {
          targetCard.translationEl.textContent = errText;
          targetCard.metaEl.textContent = 'error';
        }
      }
    } catch {
      // ignore malformed frame
    }
  });

  ws.addEventListener('close', () => {
    setBridgeStatus(false);
    setTimeout(connectWebSocket, 3000);
  });

  ws.addEventListener('error', () => {
    setBridgeStatus(false);
  });

  state.ws = ws;
}

// Listen to events relayed from Content Script & Offscreen Document
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CAPTION_UTTERANCE') {
    els.vadMeter.textContent = 'Caption DOM: Aktif';
    submitUtterance(message.utterance, { speaker: message.speaker || 'other' });
  } else if (message?.type === 'VAD_SPEECH_STATE') {
    els.vadMeter.textContent = message.speaking ? 'Tab Audio: Berbicara...' : 'Tab Audio: Hening (0 token)';
  } else if (message?.type === 'VAD_AUDIO_SEGMENT') {
    if (state.bridgeOnline && message.audioBase64) {
      els.vadMeter.textContent = 'Tab Audio: Transkripsi...';
      bridgeFetch('/api/stt', {
        method: 'POST',
        body: JSON.stringify({
          audioBase64: message.audioBase64,
          mimeType: message.mimeType || 'audio/webm',
          language: 'en'
        })
      }).then((res) => {
        if (!res?.ok && res?.error) {
          els.vadMeter.textContent = res.error;
        } else {
          els.vadMeter.textContent = 'Tab Audio: Aktif (Menunggu suara)';
        }
      }).catch(() => {});
    }
  } else if (message?.type === 'CAPTION_OBSERVER_READY') {
    els.vadMeter.textContent = `Caption DOM (${message.platform}): Siap`;
  } else if (message?.type === 'QUICK_COPY_REPLY') {
    const latestCard = els.feed.querySelector('.turn-card');
    if (!latestCard) return;
    const slotIdx = message.slot === 'r1' ? 0 : message.slot === 'r2' ? 1 : 2;
    const chips = latestCard.querySelectorAll('.reply-chip');
    const targetChip = chips[slotIdx];
    const replyText = targetChip?.querySelector('.reply-text')?.textContent?.trim();
    if (replyText) {
      navigator.clipboard.writeText(replyText).catch(() => {});
      const copyBtn = targetChip.querySelector('.btn-secondary');
      if (copyBtn) {
        copyBtn.textContent = 'Disalin (Shortcut)!';
        setTimeout(() => { copyBtn.textContent = 'Salin'; }, 1200);
      }
    }
  }
});

els.manualForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = els.manualInput.value.trim();
  if (!val) return;
  els.manualInput.value = '';
  submitUtterance(val);
});

els.btnClearFeed.addEventListener('click', () => {
  state.cardsById.clear();
  els.feed.innerHTML = '';
  if (state.bridgeOnline) {
    bridgeFetch('/api/meeting/reset', { method: 'POST', body: '{}' })
      .then((res) => updateTokenMeter(res.tokens))
      .catch(() => {});
  }
});

els.btnToggleCapture.addEventListener('click', async () => {
  const type = state.captureActive ? 'STOP_TAB_CAPTURE' : 'START_TAB_CAPTURE';
  const res = await chrome.runtime.sendMessage({ type });
  if (res?.ok) {
    state.captureActive = !state.captureActive;
    els.btnToggleCapture.textContent = state.captureActive
      ? 'Hentikan Tab Audio VAD'
      : 'Mulai Tab Audio VAD';
    els.vadMeter.textContent = state.captureActive
      ? 'Tab Audio: Aktif (Menunggu suara)'
      : 'Caption/Mic: Siap';
  } else if (res?.error) {
    els.vadMeter.textContent = res.error;
  }
});

let micSession = null;

function stopMicCapture() {
  if (!micSession) return;
  clearInterval(micSession.timer);
  if (micSession.recorder?.state !== 'inactive') micSession.recorder.stop();
  micSession.audioCtx?.close().catch(() => {});
  micSession.stream?.getTracks().forEach((t) => t.stop());
  micSession = null;
  els.btnToggleMic.textContent = 'Mic Ruangan';
  els.vadMeter.textContent = 'Caption/Mic: Siap';
}

els.btnToggleMic.addEventListener('click', async () => {
  if (micSession) {
    stopMicCapture();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    let speaking = false;
    let silence = 0;
    let chunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    let recorder = null;

    const startRec = () => {
      chunks = [];
      recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };
      recorder.onstop = async () => {
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: mimeType });
        chunks = [];
        if (blob.size < 2048 || !state.bridgeOnline) return;
        const reader = new FileReader();
        reader.onloadend = () => {
          const b64 = String(reader.result || '').split(',')[1] || '';
          if (!b64) return;
          els.vadMeter.textContent = 'Mic: Transkripsi...';
          bridgeFetch('/api/stt', {
            method: 'POST',
            body: JSON.stringify({ audioBase64: b64, mimeType, language: 'en' })
          }).then((r) => {
            els.vadMeter.textContent = r?.ok ? 'Mic: Aktif (Menunggu suara)' : (r?.error || 'Mic error');
          }).catch(() => {});
        };
        reader.readAsDataURL(blob);
      };
      recorder.start(250);
    };

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      if (rms >= 0.018) {
        silence = 0;
        if (!speaking) {
          speaking = true;
          startRec();
          els.vadMeter.textContent = 'Mic: Berbicara...';
        }
      } else if (speaking) {
        silence += 1;
        if (silence >= 11) {
          speaking = false;
          if (recorder?.state === 'recording') recorder.stop();
          els.vadMeter.textContent = 'Mic: Hening (0 token)';
        }
      }
    }, 100);

    micSession = { stream, audioCtx, recorder, timer };
    els.btnToggleMic.textContent = 'Stop Mic';
    els.vadMeter.textContent = 'Mic: Aktif (Menunggu suara)';
  } catch (err) {
    const msg = err?.message || String(err);
    if (err?.name === 'NotAllowedError' || /dismissed|denied/i.test(msg)) {
      els.vadMeter.textContent = 'Izinkan mic di tab baru, lalu klik Mic Ruangan lagi';
      chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/mic-permission.html') });
    } else {
      els.vadMeter.textContent = `Mic ditolak: ${msg}`;
    }
  }
});

els.btnSaveProviders.addEventListener('click', async () => {
  state.bridgeUrl = els.bridgeUrl.value.trim() || 'http://127.0.0.1:8787';
  state.pairToken = els.pairToken.value.trim();
  const selfName = els.selfName.value.trim();

  await chrome.storage.local.set({
    bridgeUrl: state.bridgeUrl,
    pairToken: state.pairToken,
    selfName
  });

  const payload = {
    providers: {
      nvidia: {
        enabled: true,
        ...(els.nvidiaKey.value.trim() ? { apiKey: els.nvidiaKey.value.trim() } : {}),
        model: els.nvidiaModel.value.trim() || 'nvidia/nemotron-3-ultra-550b-a55b'
      },
      groq: {
        enabled: true,
        ...(els.groqKey.value.trim() ? { apiKey: els.groqKey.value.trim() } : {})
      },
      gemini: {
        enabled: true,
        ...(els.geminiKey.value.trim() ? { apiKey: els.geminiKey.value.trim() } : {})
      },
      ollama: {
        enabled: els.ollamaEnabled.checked
      }
    }
  };

  try {
    const res = await bridgeFetch('/api/settings/providers', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    els.setupStatus.textContent = `Tersimpan! Chain aktif: ${(res.activeChain || []).map((c) => c.id).join(' → ')}`;
    connectWebSocket();
  } catch (err) {
    els.setupStatus.textContent = `Gagal simpan ke bridge: ${err.message}`;
  }
});

function getDirList() {
  return els.contextDirs.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

els.btnIndexDocs.addEventListener('click', async () => {
  const paths = getDirList();
  if (!paths.length) {
    els.setupStatus.textContent = 'Isi minimal 1 path folder/file dulu.';
    return;
  }
  await chrome.storage.local.set({ contextDirs: els.contextDirs.value, userGoal: els.userGoal.value.trim() });
  const res = await bridgeFetch('/api/context/index', {
    method: 'POST',
    body: JSON.stringify({ paths, rememberDirs: true })
  });
  els.setupStatus.textContent = `Terindeks: ${res.totalDocs || 0} dokumen (${res.totalChunks || 0} chunk).`;
});

els.btnPackGlossary.addEventListener('click', async () => {
  const paths = getDirList();
  if (!paths.length) {
    els.setupStatus.textContent = 'Isi minimal 1 path folder/file dulu.';
    return;
  }
  const userGoal = els.userGoal.value.trim();
  const res = await bridgeFetch('/api/context/pack-glossary', {
    method: 'POST',
    body: JSON.stringify({ paths, maxTokens: 400, userGoal, applyToMeeting: true })
  });
  state.cheatSheet = res.cheatSheet || '';
  els.setupStatus.textContent = `Cheat Sheet siap (${res.estimatedTokens || 0} token, ${res.glossaryTerms?.length || 0} istilah).`;
});

// Initialize saved settings on panel open
chrome.storage.local.get(
  ['bridgeUrl', 'pairToken', 'selfName', 'contextDirs', 'userGoal'],
  (saved) => {
    if (saved.bridgeUrl) {
      state.bridgeUrl = saved.bridgeUrl;
      els.bridgeUrl.value = saved.bridgeUrl;
    }
    if (saved.pairToken) {
      state.pairToken = saved.pairToken;
      els.pairToken.value = saved.pairToken;
    }
    if (saved.selfName) els.selfName.value = saved.selfName;
    if (saved.contextDirs) els.contextDirs.value = saved.contextDirs;
    if (saved.userGoal) els.userGoal.value = saved.userGoal;
    connectWebSocket();
  }
);
