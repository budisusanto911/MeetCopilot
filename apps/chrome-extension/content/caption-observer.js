/**
 * Zero-cost Live Caption DOM Observer for Google Meet, MS Teams, and Zoom Web.
 * Debounces partial caption mutations locally so AI is only called on completed turns.
 */

(() => {
  const DEBOUNCE_MS = 1150;
  const SENTENCE_END_DEBOUNCE_MS = 750;
  const MIN_WORDS_FOR_QUICK_FLUSH = 5;

  let selfName = '';
  let enabled = true;
  let lastSpeaker = 'other';
  let pendingText = '';
  let lastEmittedText = '';
  let flushTimer = null;
  let scheduledRaf = false;

  chrome.storage.local.get(['selfName', 'captionObserverEnabled'], (data) => {
    if (data.selfName) selfName = String(data.selfName).trim().toLowerCase();
    if (typeof data.captionObserverEnabled === 'boolean') {
      enabled = data.captionObserverEnabled;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.selfName) {
      selfName = String(changes.selfName.newValue || '').trim().toLowerCase();
    }
    if (changes.captionObserverEnabled) {
      enabled = Boolean(changes.captionObserverEnabled.newValue);
    }
  });

  function detectPlatform(hostname) {
    if (hostname.includes('meet.google.com')) return 'meet';
    if (hostname.includes('teams.')) return 'teams';
    if (hostname.includes('zoom.us')) return 'zoom';
    return 'unknown';
  }

  function extractLatestCaption(platform) {
    if (platform === 'meet') {
      const blocks = document.querySelectorAll(
        '[aria-live="polite"] .iOzk7, [jsname="tgaKEf"], .a4cQT .CNusmb, [data-self-name]'
      );
      if (blocks.length) {
        const last = blocks[blocks.length - 1];
        const container = last.closest('[data-sender-name], .nMcdL, .a4cQT') || last.parentElement;
        const speakerEl = container?.querySelector?.('.zs7s8d, .KcIKyf, [data-sender-name]');
        const speakerName =
          speakerEl?.getAttribute?.('data-sender-name') ||
          speakerEl?.textContent?.trim() ||
          '';
        const text = last.textContent?.trim() || '';
        if (text) return { speakerName, text };
      }

      // Resilient fallback if Meet updates minified CSS class names
      const region =
        document.querySelector('[role="region"][aria-label*="caption" i]') ||
        document.querySelector('[aria-live="polite"]');
      const fallbackText = region?.innerText?.trim() || '';
      if (fallbackText) {
        const lines = fallbackText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
        const text = lines[lines.length - 1] || '';
        const speakerName = lines.length >= 2 ? lines[lines.length - 2] : '';
        if (text) return { speakerName, text };
      }
      return null;
    }

    if (platform === 'teams') {
      const items = document.querySelectorAll(
        '[data-tid="closed-captions-renderer"] [data-tid="closed-caption-text"], .ui-chat__message__content'
      );
      if (!items.length) return null;
      const last = items[items.length - 1];
      const parent = last.closest('[data-tid="closed-caption-item"]') || last.parentElement;
      const speakerName =
        parent?.querySelector?.('[data-tid="closed-caption-author"]')?.textContent?.trim() || '';
      const text = last.textContent?.trim() || '';
      return text ? { speakerName, text } : null;
    }

    if (platform === 'zoom') {
      const items = document.querySelectorAll(
        '.live-transcription-subtitle__item, .closed-caption-display__text, [class*="caption-text"]'
      );
      if (!items.length) return null;
      const last = items[items.length - 1];
      const text = last.textContent?.trim() || '';
      return text ? { speakerName: '', text } : null;
    }

    return null;
  }

  function flushPending() {
    clearTimeout(flushTimer);
    flushTimer = null;

    const clean = pendingText.replace(/\s+/g, ' ').trim();
    pendingText = '';
    if (!clean || clean === lastEmittedText) return;

    if (selfName && lastSpeaker && lastSpeaker.toLowerCase().includes(selfName)) {
      return;
    }

    lastEmittedText = clean;
    chrome.runtime.sendMessage({
      type: 'CAPTION_UTTERANCE',
      utterance: clean,
      speaker: lastSpeaker || 'other',
      source: 'caption-dom'
    }).catch(() => {});
  }

  function handleCaptionSample(sample) {
    if (!enabled || !sample?.text) return;
    const clean = sample.text.replace(/\s+/g, ' ').trim();
    if (!clean || clean === pendingText || clean === lastEmittedText) return;

    // If speaker changed mid-stream, flush previous speaker immediately
    if (
      pendingText &&
      sample.speakerName &&
      lastSpeaker !== 'other' &&
      sample.speakerName !== lastSpeaker
    ) {
      flushPending();
    }

    lastSpeaker = sample.speakerName || 'other';
    pendingText = clean;

    clearTimeout(flushTimer);
    const wordCount = clean.split(/\s+/).length;
    const endsSentence = /[.?!]$/.test(clean) && wordCount >= MIN_WORDS_FOR_QUICK_FLUSH;
    flushTimer = setTimeout(
      flushPending,
      endsSentence ? SENTENCE_END_DEBOUNCE_MS : DEBOUNCE_MS
    );
  }

  const platform = detectPlatform(window.location.hostname);
  if (platform === 'unknown') return;

  const observer = new MutationObserver(() => {
    if (scheduledRaf || !enabled) return;
    scheduledRaf = true;
    requestAnimationFrame(() => {
      scheduledRaf = false;
      const sample = extractLatestCaption(platform);
      if (sample) handleCaptionSample(sample);
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  chrome.runtime.sendMessage({
    type: 'CAPTION_OBSERVER_READY',
    platform
  }).catch(() => {});
})();
