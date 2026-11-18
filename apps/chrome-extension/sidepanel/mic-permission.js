const statusEl = document.getElementById('status');
const btn = document.getElementById('grantBtn');

async function requestMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    statusEl.style.color = '#34d399';
    statusEl.textContent = 'Berhasil! Izin mikrofon sudah aktif. Tutup tab ini lalu klik "Mic Ruangan" di Side Panel.';
  } catch (err) {
    statusEl.style.color = '#fca5a5';
    statusEl.textContent = `Gagal: ${err.message}. Pastikan ikon kamera/mic di address bar tidak diblokir.`;
  }
}

btn.addEventListener('click', requestMic);
