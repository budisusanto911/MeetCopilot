/**
 * Offscreen Document for Tab Audio Capture + Local RMS Voice Activity Detection.
 * Keeps meeting playback audible and records ONLY active speech segments (0 idle data)
 * to send for STT when Live Captions (CC) are unavailable.
 */

let mediaStream = null;
let audioCtx = null;
let vadTimer = null;
let recorder = null;
let speechChunks = [];
let isSpeaking = false;
let silenceFrames = 0;

const RMS_THRESHOLD = 0.015;
const SILENCE_FRAMES_TO_IDLE = 11; // ~1.1s pause triggers turn end

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function stopCapture() {
  if (vadTimer) {
    clearInterval(vadTimer);
    vadTimer = null;
  }
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
  recorder = null;
  speechChunks = [];
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  isSpeaking = false;
  silenceFrames = 0;
}

function startSegmentRecorder() {
  if (!mediaStream || (recorder && recorder.state === 'recording')) return;
  speechChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  recorder = new MediaRecorder(mediaStream, { mimeType });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) speechChunks.push(e.data);
  };
  recorder.onstop = async () => {
    if (!speechChunks.length) return;
    const blob = new Blob(speechChunks, { type: mimeType });
    speechChunks = [];
    // Ignore tiny < 2 KB clicks/pops
    if (blob.size < 2048) return;
    const audioBase64 = await blobToBase64(blob);
    chrome.runtime.sendMessage({
      type: 'VAD_AUDIO_SEGMENT',
      audioBase64,
      mimeType
    }).catch(() => {});
  };
  recorder.start(250);
}

async function startCapture(streamId) {
  stopCapture();

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;

  // Route audio back to speakers so meeting stays audible
  source.connect(analyser);
  source.connect(audioCtx.destination);

  const pcmBuffer = new Float32Array(analyser.fftSize);
  vadTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(pcmBuffer);
    let sumSq = 0;
    for (let i = 0; i < pcmBuffer.length; i += 1) {
      sumSq += pcmBuffer[i] * pcmBuffer[i];
    }
    const rms = Math.sqrt(sumSq / pcmBuffer.length);

    if (rms >= RMS_THRESHOLD) {
      silenceFrames = 0;
      if (!isSpeaking) {
        isSpeaking = true;
        startSegmentRecorder();
        chrome.runtime.sendMessage({ type: 'VAD_SPEECH_STATE', speaking: true, rms }).catch(() => {});
      }
    } else if (isSpeaking) {
      silenceFrames += 1;
      if (silenceFrames >= SILENCE_FRAMES_TO_IDLE) {
        isSpeaking = false;
        if (recorder && recorder.state === 'recording') {
          recorder.stop();
        }
        chrome.runtime.sendMessage({ type: 'VAD_SPEECH_STATE', speaking: false, rms }).catch(() => {});
      }
    }
  }, 100);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'OFFSCREEN_START_CAPTURE') {
    startCapture(message.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (message?.type === 'OFFSCREEN_STOP_CAPTURE') {
    stopCapture();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
