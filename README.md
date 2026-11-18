# MeetCopilot — Real-Time AI Meeting Translator & Reply Copilot

Asisten meeting bilingual real-time (**Inggris → Indonesia natural**) yang langsung memberi **3 opsi jawaban kontekstual** berdasarkan dokumen lokal di laptop atau HP kamu, menggunakan **AI gratis (Free Waterfall: NVIDIA NIM → Groq/Gemini Free → Ollama Lokal)** dan **7-layer penghemat token**.

---

## Fitur Utama

- **Terjemahan AI Natural + 3 Opsi Jawaban Instan**:
  - **Opsi 1 (Quick)**: Jawaban singkat langsung ke inti.
  - **Opsi 2 (Context)**: Jawaban menyeluruh berbasis dokumen kerja/CV kamu.
  - **Opsi 3 (Clarify / Buy Time)**: Kalimat sopan untuk memastikan maksud atau mengulur waktu berpikir.
- **Super Irit Token**:
  - Caption DOM Observer (Google Meet / MS Teams / Zoom Web) membaca teks CC dengan **0 biaya STT**.
  - Filter basa-basi & frasa umum lokal (`Tier-0`, 0 token), *Intent-Gated RAG* (hanya cari dokumen saat ditanya fakta/proyek), *Rolling Memory* (`<= 4` giliran terakhir), dan format streaming ringkas `T|Q|R1|R2|R3`.
- **Anti-Mati Tengah Meeting (Free Waterfall)**:
  - Primary: **NVIDIA NIM Free** (`https://integrate.api.nvidia.com/v1`)
  - Auto-Fallback #1: **Groq Free** / **Google AI Studio (Gemini Flash Free)** saat kena `429` atau lambat.
  - Auto-Fallback #2: **Ollama Lokal** untuk mode offline atau data rahasia/NDA.

---

## Cara Menjalankan

### 1. Jalankan Local Bridge (Laptop)
```bash
cp .env.example .env.local
# Isi NVIDIA_API_KEY (wajib untuk primary gratis), dan opsional GROQ_API_KEY / GEMINI_API_KEY
npm run bridge
```
> Untuk **Mode Companion ke HP** lewat Wi-Fi LAN, set `BRIDGE_HOST=0.0.0.0` dan `BRIDGE_PAIR_TOKEN=rahasia-kamu` di `.env.local`.

### 2. Pasang Chrome Extension (Laptop)
1. Buka `chrome://extensions` di Google Chrome.
2. Aktifkan **Developer mode** (pojok kanan atas).
3. Klik **Load unpacked**, lalu pilih folder `apps/chrome-extension`.
4. Klik ikon **MeetCopilot** (atau tekan `Alt+Shift+M`) untuk membuka **Side Panel** (aman dari *screen share* tab/jendela).
5. **Shortcut Cepat**:
   - `Alt+Shift+M`: Buka Side Panel
   - `Alt+Shift+1` / `2` / `3`: Salin cepat Opsi Jawaban 1, 2, atau 3.

### 3. Aplikasi HP Android (`apps/mobile-app`)
1. Buka folder `apps/mobile-app` di **Android Studio**.
2. Build & jalankan ke HP Android (`minSdk 26`).
3. Pilih mode sesuai kondisi:
   - **Mulai Mic**: Dengarkan suara dari laptop/tatap muka, tekan **Saya Ngomong** saat giliran kamu bicara.
   - **Sync Laptop**: Hubungkan ke `http://<IP-LAPTOP>:8787` sebagai layar teleprompter kedua.
   - **Floating Overlay**: Tampilkan kartu jawaban melayang di atas aplikasi meeting HP.

---

## Verifikasi & Audit Token

```bash
npm test          # Jalankan seluruh unit & integration test
npm run audit-tokens  # Simulasi 48 ujaran meeting & verifikasi batas token
```
