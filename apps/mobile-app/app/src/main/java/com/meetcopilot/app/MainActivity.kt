package com.meetcopilot.app

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import android.util.Xml
import org.xmlpull.v1.XmlPullParser
import java.util.Locale
import java.util.zip.ZipInputStream

class MainActivity : ComponentActivity(), TextToSpeech.OnInitListener {
    private val networkClient = WaterfallNetworkClient()
    private lateinit var vault: LocalContextVault
    private var speechRecognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null

    private var nvidiaKey by mutableStateOf("")
    private var groqKey by mutableStateOf("")
    private var geminiKey by mutableStateOf("")
    private var bridgeUrl by mutableStateOf("http://192.168.1.10:8787")
    private var pairToken by mutableStateOf("")
    private var userGoal by mutableStateOf("")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vault = LocalContextVault(this)
        tts = TextToSpeech(this, this)
        loadPrefs()

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                MeetCopilotScreen()
            }
        }
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            tts?.language = Locale.US
            tts?.setSpeechRate(0.88f)
        }
    }

    override fun onDestroy() {
        speechRecognizer?.destroy()
        networkClient.disconnectWebSocket()
        tts?.shutdown()
        super.onDestroy()
    }

    private fun loadPrefs() {
        val prefs = getSharedPreferences("meetcopilot_prefs", MODE_PRIVATE)
        nvidiaKey = prefs.getString("nvidiaKey", "") ?: ""
        groqKey = prefs.getString("groqKey", "") ?: ""
        geminiKey = prefs.getString("geminiKey", "") ?: ""
        bridgeUrl = prefs.getString("bridgeUrl", "http://192.168.1.10:8787") ?: "http://192.168.1.10:8787"
        pairToken = prefs.getString("pairToken", "") ?: ""
        userGoal = prefs.getString("userGoal", "") ?: ""
    }

    private fun savePrefs() {
        getSharedPreferences("meetcopilot_prefs", MODE_PRIVATE).edit()
            .putString("nvidiaKey", nvidiaKey.trim())
            .putString("groqKey", groqKey.trim())
            .putString("geminiKey", geminiKey.trim())
            .putString("bridgeUrl", bridgeUrl.trim())
            .putString("pairToken", pairToken.trim())
            .putString("userGoal", userGoal.trim())
            .apply()
    }

    private fun buildProviderList(): List<AiProviderConfig> = listOf(
        AiProviderConfig("nvidia", "https://integrate.api.nvidia.com/v1", "meta/llama-3.1-8b-instruct", nvidiaKey.trim()),
        AiProviderConfig("groq", "https://api.groq.com/openai/v1", "llama-3.1-8b-instant", groqKey.trim()),
        AiProviderConfig("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash-lite", geminiKey.trim())
    )

    private fun handleUtterance(rawText: String, forceDeep: Boolean = false) {
        val state = CopilotStateBus.state.value
        if (state.companionConnected && !forceDeep) {
            networkClient.sendCompanionUtterance(rawText, forceDeep)
            return
        }

        when (val decision = TokenFrugalEngine.evaluateTier0(rawText)) {
            is Tier0Decision.Drop -> {
                CopilotStateBus.update { it.copy(statusText = "Skip filler (${decision.reason}) · 0 token") }
                return
            }
            is Tier0Decision.Instant -> {
                CopilotStateBus.upsertTurn(
                    TurnEntry(
                        id = "hp-${System.currentTimeMillis()}",
                        utterance = rawText,
                        result = decision.result,
                        providerUsed = "tier0-phrase"
                    )
                )
                return
            }
            is Tier0Decision.CallLlm -> {
                val id = "hp-${System.currentTimeMillis()}"
                val normalized = decision.normalized
                CopilotStateBus.upsertTurn(
                    TurnEntry(id = id, utterance = normalized, result = CopilotResult(t = "Menerjemahkan..."))
                )

                lifecycleScope.launch {
                    try {
                        val ragQuery = if (forceDeep) normalized else TokenFrugalEngine.extractRagQuery(normalized)
                        val ragSnippets = if (ragQuery != null) vault.querySnippets(ragQuery) else emptyList()
                        val sysPrompt = TokenFrugalEngine.buildSystemPrompt(userGoal = userGoal)
                        val usrPrompt = TokenFrugalEngine.buildUserPrompt(
                            utterance = normalized,
                            recentTurns = CopilotStateBus.state.value.turns,
                            ragSnippets = ragSnippets
                        )

                        val (finalRes, providerUsed) = networkClient.streamWaterfallCompletion(
                            providers = buildProviderList(),
                            systemPrompt = sysPrompt,
                            userPrompt = usrPrompt
                        ) { partial, providerId ->
                            CopilotStateBus.upsertTurn(
                                TurnEntry(
                                    id = id,
                                    utterance = normalized,
                                    result = partial,
                                    providerUsed = providerId,
                                    usedRag = ragSnippets.isNotEmpty()
                                )
                            )
                        }

                        CopilotStateBus.upsertTurn(
                            TurnEntry(
                                id = id,
                                utterance = normalized,
                                result = finalRes,
                                providerUsed = providerUsed,
                                usedRag = ragSnippets.isNotEmpty()
                            )
                        )
                    } catch (err: Exception) {
                        CopilotStateBus.upsertTurn(
                            TurnEntry(
                                id = id,
                                utterance = normalized,
                                result = CopilotResult(t = "Error: ${err.message}"),
                                providerUsed = "error"
                            )
                        )
                    }
                }
            }
        }
    }

    private fun startMicListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            CopilotStateBus.update { it.copy(statusText = "SpeechRecognizer tidak tersedia di HP ini") }
            return
        }
        speechRecognizer?.destroy()
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}

                override fun onError(error: Int) {
                    val s = CopilotStateBus.state.value
                    if (s.micListening && !s.micPausedSelfSpeaking) {
                        startRecognizerCycle()
                    }
                }

                override fun onResults(results: Bundle?) {
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                    val s = CopilotStateBus.state.value
                    if (!text.isNullOrBlank() && !s.micPausedSelfSpeaking) {
                        handleUtterance(text)
                    }
                    if (s.micListening && !s.micPausedSelfSpeaking) {
                        startRecognizerCycle()
                    }
                }
            })
        }
        CopilotStateBus.update { it.copy(micListening = true, micPausedSelfSpeaking = false, statusText = "Mic aktif mendengarkan...") }
        startRecognizerCycle()
    }

    private fun startRecognizerCycle() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        }
        speechRecognizer?.startListening(intent)
    }

    private fun stopMicListening() {
        CopilotStateBus.update { it.copy(micListening = false, micPausedSelfSpeaking = false, statusText = "Mic dimatikan") }
        speechRecognizer?.stopListening()
        speechRecognizer?.destroy()
        speechRecognizer = null
    }

    private fun extractDocxText(uri: Uri): String {
        val sb = StringBuilder()
        contentResolver.openInputStream(uri)?.use { stream ->
            ZipInputStream(stream).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    if (entry.name == "word/document.xml") {
                        val parser = Xml.newPullParser()
                        parser.setInput(zis, "UTF-8")
                        var event = parser.eventType
                        while (event != XmlPullParser.END_DOCUMENT) {
                            if (event == XmlPullParser.START_TAG && parser.name?.endsWith("t") == true) {
                                sb.append(parser.nextText()).append(' ')
                            } else if (event == XmlPullParser.END_TAG && parser.name?.endsWith("p") == true) {
                                sb.append('\n')
                            }
                            event = parser.next()
                        }
                        break
                    }
                    entry = zis.nextEntry
                }
            }
        }
        return sb.toString()
    }

    private fun importFileFromUri(uri: Uri) {
        val name = contentResolver.query(uri, null, null, null, null)?.use { c ->
            val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (idx >= 0 && c.moveToFirst()) c.getString(idx) else "doc.txt"
        } ?: "doc.txt"

        val content = if (name.endsWith(".docx", ignoreCase = true)) {
            extractDocxText(uri)
        } else {
            contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } ?: ""
        }
        val chunks = vault.indexDocument(name, content)
        CopilotStateBus.update { it.copy(statusText = "Dokumen '$name' diindeks ($chunks chunk)") }
    }

    @Composable
    private fun MeetCopilotScreen() {
        val uiState by CopilotStateBus.state.collectAsState()
        var selectedTab by remember { mutableIntStateOf(0) }
        var manualText by remember { mutableStateOf("") }

        val micPermissionLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { granted ->
            if (granted) startMicListening()
            else CopilotStateBus.update { it.copy(statusText = "Izin mikrofon ditolak") }
        }

        val docPickerLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.OpenDocument()
        ) { uri -> if (uri != null) importFileFromUri(uri) }

        Scaffold(
            containerColor = Color(0xFF0F172A),
            topBar = {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFF1E293B))
                        .padding(12.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("MeetCopilot HP", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = Color.White, modifier = Modifier.weight(1f))
                        AssistChip(
                            onClick = {},
                            label = { Text(if (uiState.companionConnected) "Companion ON" else uiState.activeProvider, fontSize = 11.sp) }
                        )
                    }
                    Text(uiState.statusText, fontSize = 12.sp, color = Color(0xFF94A3B8))
                    TabRow(selectedTabIndex = selectedTab, containerColor = Color(0xFF1E293B)) {
                        Tab(selected = selectedTab == 0, onClick = { selectedTab = 0 }, text = { Text("Live Copilot") })
                        Tab(selected = selectedTab == 1, onClick = { selectedTab = 1 }, text = { Text("Setup & Dokumen") })
                    }
                }
            }
        ) { padding ->
            if (selectedTab == 0) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = {
                                if (uiState.micListening) {
                                    stopMicListening()
                                } else if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                                    startMicListening()
                                } else {
                                    micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                }
                            },
                            modifier = Modifier.weight(1f)
                        ) {
                            Text(if (uiState.micListening) "Stop Mic" else "Mulai Mic")
                        }

                        OutlinedButton(
                            onClick = {
                                val nextPaused = !uiState.micPausedSelfSpeaking
                                CopilotStateBus.update {
                                    it.copy(
                                        micPausedSelfSpeaking = nextPaused,
                                        statusText = if (nextPaused) "Dijeda (Saya lagi ngomong)" else "Mendengarkan lagi..."
                                    )
                                }
                                if (nextPaused) speechRecognizer?.stopListening()
                                else if (uiState.micListening) startRecognizerCycle()
                            },
                            enabled = uiState.micListening,
                            modifier = Modifier.weight(1f)
                        ) {
                            Text(if (uiState.micPausedSelfSpeaking) "Lanjut Dengar" else "Saya Ngomong")
                        }
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = {
                                if (uiState.companionConnected) {
                                    networkClient.disconnectWebSocket()
                                } else {
                                    networkClient.connectCompanionWebSocket(
                                        bridgeHttpUrl = bridgeUrl,
                                        pairToken = pairToken,
                                        onStatus = { ok ->
                                            CopilotStateBus.update {
                                                it.copy(
                                                    companionConnected = ok,
                                                    statusText = if (ok) "Terhubung ke Laptop Bridge" else "Koneksi Companion terputus"
                                                )
                                            }
                                        },
                                        onTurnPartial = { id, partial ->
                                            CopilotStateBus.upsertTurn(TurnEntry(id = id, utterance = "...", result = partial, providerUsed = "companion"))
                                        },
                                        onTurnDone = { entry -> CopilotStateBus.upsertTurn(entry) }
                                    )
                                }
                            },
                            modifier = Modifier.weight(1f)
                        ) {
                            Text(if (uiState.companionConnected) "Putus Laptop" else "Sync Laptop")
                        }

                        OutlinedButton(
                            onClick = {
                                if (!Settings.canDrawOverlays(this@MainActivity)) {
                                    startActivity(
                                        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
                                    )
                                } else {
                                    val svc = Intent(this@MainActivity, OverlayCopilotService::class.java)
                                    if (uiState.overlayRunning) stopService(svc)
                                    else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc)
                                    else startService(svc)
                                }
                            },
                            modifier = Modifier.weight(1f)
                        ) {
                            Text(if (uiState.overlayRunning) "Tutup Overlay" else "Floating Overlay")
                        }
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = manualText,
                            onValueChange = { manualText = it },
                            placeholder = { Text("Tes cepat kalimat Inggris...") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        Button(onClick = {
                            if (manualText.isNotBlank()) {
                                handleUtterance(manualText)
                                manualText = ""
                            }
                        }) { Text("Kirim") }
                    }

                    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(uiState.turns, key = { it.id }) { turn ->
                            TurnCard(turn)
                        }
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    item {
                        Text("Koneksi Companion Laptop", color = Color(0xFF38BDF8), fontWeight = FontWeight.Bold)
                        OutlinedTextField(value = bridgeUrl, onValueChange = { bridgeUrl = it }, label = { Text("Laptop Bridge URL (Wi-Fi LAN)") }, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(value = pairToken, onValueChange = { pairToken = it }, label = { Text("Pair Token") }, modifier = Modifier.fillMaxWidth())
                    }
                    item {
                        Text("AI Gratis Standalone (Free Waterfall)", color = Color(0xFF38BDF8), fontWeight = FontWeight.Bold)
                        OutlinedTextField(value = nvidiaKey, onValueChange = { nvidiaKey = it }, label = { Text("NVIDIA NIM Key (Primary)") }, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(value = groqKey, onValueChange = { groqKey = it }, label = { Text("Groq Key (Fallback #1)") }, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(value = geminiKey, onValueChange = { geminiKey = it }, label = { Text("Gemini Key (Fallback #2)") }, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(value = userGoal, onValueChange = { userGoal = it }, label = { Text("Peran / Topik Meeting") }, modifier = Modifier.fillMaxWidth())
                        Button(onClick = {
                            savePrefs()
                            CopilotStateBus.update { it.copy(statusText = "Pengaturan disimpan") }
                        }, modifier = Modifier.fillMaxWidth()) { Text("Simpan Pengaturan") }
                    }
                    item {
                        Text("Dokumen Konteks di HP (SQLite FTS4)", color = Color(0xFF38BDF8), fontWeight = FontWeight.Bold)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = {
                                    docPickerLauncher.launch(
                                        arrayOf(
                                            "text/*",
                                            "application/json",
                                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                                        )
                                    )
                                },
                                modifier = Modifier.weight(1f)
                            ) { Text("Impor TXT/MD/DOCX") }
                            OutlinedButton(
                                onClick = {
                                    vault.clearAll()
                                    CopilotStateBus.update { it.copy(statusText = "Vault HP dibersihkan") }
                                },
                                modifier = Modifier.weight(1f)
                            ) { Text("Reset Vault") }
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun TurnCard(turn: TurnEntry) {
        Card(
            colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(turn.utterance, fontSize = 11.5.sp, color = Color(0xFF94A3B8))
                Text(turn.result.t.ifBlank { "..." }, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = Color.White)

                val options = listOf(
                    "Opsi 1 · Quick" to turn.result.r1,
                    (if (turn.usedRag) "Opsi 2 · Context (Dokumen)" else "Opsi 2 · Detail") to turn.result.r2,
                    "Opsi 3 · Klarifikasi" to turn.result.r3
                ).filter { it.second.isNotBlank() }

                options.forEach { (label, text) ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xFF273449), RoundedCornerShape(8.dp))
                            .padding(8.dp)
                    ) {
                        Text(label, fontSize = 10.sp, color = Color(0xFF38BDF8), fontWeight = FontWeight.Bold)
                        Text(text, fontSize = 13.sp, color = Color(0xFFF1F5F9))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = {
                                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                cm.setPrimaryClip(ClipData.newPlainText("MeetCopilot", text))
                            }) { Text("Salin", fontSize = 11.sp) }
                            TextButton(onClick = {
                                tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "reply")
                            }) { Text("🔊 Pelan", fontSize = 11.sp) }
                            TextButton(onClick = {
                                if (CopilotStateBus.state.value.companionConnected) {
                                    networkClient.sendCompanionMarkReply(text)
                                }
                            }) { Text("Sudah Dijawab", fontSize = 11.sp) }
                        }
                    }
                }
            }
        }
    }
}
