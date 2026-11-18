/**
 * MeetCopilot MV3 Service Worker
 * Manages Side Panel behavior, tabCapture state locking, Offscreen Document lifecycle,
 * and message routing between meeting tabs and the Side Panel.
 */

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
});

// Ensure clicking the toolbar icon always opens the Side Panel even after SW restart
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-side-panel') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
    return;
  }

  const slotMap = {
    'copy-reply-1': 'r1',
    'copy-reply-2': 'r2',
    'copy-reply-3': 'r3'
  };
  const slot = slotMap[command];
  if (slot) {
    chrome.runtime.sendMessage({ type: 'QUICK_COPY_REPLY', slot }).catch(() => {});
  }
});

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Capture active meeting tab audio for local VAD without muting speaker playback.'
  });
}

async function startTabCapture(tabId) {
  const { captureState = 'idle' } = await chrome.storage.session.get('captureState');
  if (captureState === 'starting' || captureState === 'stopping' || captureState === 'active') {
    return { ok: false, error: `Capture already ${captureState}` };
  }

  await chrome.storage.session.set({ captureState: 'starting' });
  try {
    let targetTabId = tabId;
    if (!targetTabId) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = activeTab?.id;
    }
    if (!targetTabId) {
      throw new Error('Tidak ada tab meeting aktif yang ditemukan.');
    }

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START_CAPTURE',
      streamId,
      tabId: targetTabId
    });

    await chrome.storage.session.set({ captureState: 'active', activeTabId: targetTabId });
    await chrome.action.setBadgeText({ text: 'LIVE' });
    await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    return { ok: true, tabId: targetTabId };
  } catch (err) {
    await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
    await chrome.action.setBadgeText({ text: '' });
    return { ok: false, error: err.message || String(err) };
  }
}

async function stopTabCapture() {
  const { captureState = 'idle' } = await chrome.storage.session.get('captureState');
  if (captureState === 'idle' || captureState === 'stopping') {
    return { ok: true };
  }

  await chrome.storage.session.set({ captureState: 'stopping' });
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_CAPTURE' }).catch(() => {});
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  } finally {
    await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
    await chrome.action.setBadgeText({ text: '' });
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'START_TAB_CAPTURE':
        sendResponse(await startTabCapture(message.tabId));
        break;

      case 'STOP_TAB_CAPTURE':
        sendResponse(await stopTabCapture());
        break;

      case 'GET_CAPTURE_STATUS': {
        const state = await chrome.storage.session.get(['captureState', 'activeTabId']);
        sendResponse({ ok: true, ...state });
        break;
      }

      case 'CAPTION_UTTERANCE':
      case 'VAD_SPEECH_STATE':
      case 'VAD_AUDIO_SEGMENT':
      case 'CAPTION_OBSERVER_READY':
        // Broadcast meeting tab events to open Side Panel views
        chrome.runtime.sendMessage({
          ...message,
          tabId: sender?.tab?.id || message.tabId || null
        }).catch(() => {});
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true;
});
