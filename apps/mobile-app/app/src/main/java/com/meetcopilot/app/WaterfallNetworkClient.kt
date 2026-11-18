package com.meetcopilot.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.util.concurrent.TimeUnit

data class AiProviderConfig(
    val id: String,
    val baseUrl: String,
    val model: String,
    val apiKey: String
)

class WaterfallNetworkClient {
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .writeTimeout(6, TimeUnit.SECONDS)
        .build()

    private var activeWebSocket: WebSocket? = null

    fun connectCompanionWebSocket(
        bridgeHttpUrl: String,
        pairToken: String,
        onStatus: (Boolean) -> Unit,
        onTurnPartial: (String, CopilotResult) -> Unit,
        onTurnDone: (TurnEntry) -> Unit
    ) {
        disconnectWebSocket()
        val wsUrl = bridgeHttpUrl.trim().trimEnd('/')
            .replace(Regex("^http://", RegexOption.IGNORE_CASE), "ws://")
            .replace(Regex("^https://", RegexOption.IGNORE_CASE), "wss://")
            .let { base ->
                if (pairToken.isNotBlank()) "$base/ws?token=$pairToken" else "$base/ws"
            }

        val request = Request.Builder().url(wsUrl).build()
        activeWebSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                onStatus(true)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    val json = JSONObject(text)
                    val type = json.optString("type")
                    val id = json.optString("id", System.currentTimeMillis().toString())
                    when (type) {
                        "turn_partial" -> {
                            val p = json.optJSONObject("partial") ?: return
                            onTurnPartial(id, jsonToResult(p))
                        }
                        "turn_done" -> {
                            if (json.optBoolean("skipped", false)) return
                            val r = json.optJSONObject("result") ?: return
                            onTurnDone(
                                TurnEntry(
                                    id = id,
                                    utterance = json.optString("utterance"),
                                    result = jsonToResult(r),
                                    providerUsed = json.optString("providerUsed", "bridge"),
                                    usedRag = json.optBoolean("usedRag", false)
                                )
                            )
                        }
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onStatus(false)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onStatus(false)
            }
        })
    }

    fun sendCompanionMarkReply(reply: String) {
        val payload = JSONObject().put("type", "mark_reply").put("reply", reply).toString()
        activeWebSocket?.send(payload)
    }

    fun sendCompanionUtterance(utterance: String, forceDeepContext: Boolean = false) {
        val payload = JSONObject()
            .put("type", "utterance")
            .put("id", "hp-${System.currentTimeMillis()}")
            .put("utterance", utterance)
            .put("forceDeepContext", forceDeepContext)
            .toString()
        activeWebSocket?.send(payload)
    }

    fun disconnectWebSocket() {
        activeWebSocket?.close(1000, "closed")
        activeWebSocket = null
    }

    suspend fun streamWaterfallCompletion(
        providers: List<AiProviderConfig>,
        systemPrompt: String,
        userPrompt: String,
        onPartial: (CopilotResult, String) -> Unit
    ): Pair<CopilotResult, String> = withContext(Dispatchers.IO) {
        val errors = mutableListOf<String>()
        for (provider in providers) {
            if (provider.apiKey.isBlank() && !provider.baseUrl.contains("127.0.0.1")) continue
            try {
                val raw = callProviderStream(provider, systemPrompt, userPrompt) { accumulated ->
                    onPartial(TokenFrugalEngine.parseWireOutput(accumulated), provider.id)
                }
                return@withContext TokenFrugalEngine.parseWireOutput(raw) to provider.id
            } catch (err: Exception) {
                errors.add("${provider.id}: ${err.message}")
            }
        }
        throw IllegalStateException("Semua provider gagal: ${errors.joinToString(" | ")}")
    }

    private fun callProviderStream(
        provider: AiProviderConfig,
        systemPrompt: String,
        userPrompt: String,
        onAccumulated: (String) -> Unit
    ): String {
        val bodyJson = JSONObject()
            .put("model", provider.model)
            .put("max_tokens", TokenFrugalEngine.MAX_OUTPUT_TOKENS)
            .put("temperature", 0.25)
            .put("stream", true)
            .put(
                "messages",
                JSONArray()
                    .put(JSONObject().put("role", "system").put("content", systemPrompt))
                    .put(JSONObject().put("role", "user").put("content", userPrompt))
            )

        val reqBuilder = Request.Builder()
            .url("${provider.baseUrl.trimEnd('/')}/chat/completions")
            .post(bodyJson.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))

        if (provider.apiKey.isNotBlank()) {
            reqBuilder.header("Authorization", "Bearer ${provider.apiKey}")
        }

        httpClient.newCall(reqBuilder.build()).execute().use { res ->
            if (!res.isSuccessful) {
                throw IllegalStateException("HTTP ${res.code}")
            }
            val body = res.body ?: throw IllegalStateException("Empty body")
            val reader = BufferedReader(body.charStream())
            val fullText = StringBuilder()

            while (true) {
                val line = reader.readLine() ?: break
                val trimmed = line.trim()
                if (!trimmed.startsWith("data:")) continue
                val payload = trimmed.removePrefix("data:").trim()
                if (payload.isEmpty() || payload == "[DONE]") continue

                runCatching {
                    val obj = JSONObject(payload)
                    val choices = obj.optJSONArray("choices") ?: return@runCatching
                    val first = choices.optJSONObject(0) ?: return@runCatching
                    val delta = first.optJSONObject("delta")?.optString("content", "")
                        ?: first.optJSONObject("message")?.optString("content", "")
                        ?: ""
                    if (delta.isNotEmpty()) {
                        fullText.append(delta)
                        onAccumulated(fullText.toString())
                    }
                }
            }

            val result = fullText.toString()
            if (result.isBlank()) throw IllegalStateException("Empty stream")
            return result
        }
    }

    private fun jsonToResult(obj: JSONObject): CopilotResult = CopilotResult(
        t = obj.optString("t"),
        q = obj.optBoolean("q", false),
        r1 = obj.optString("r1"),
        r2 = obj.optString("r2"),
        r3 = obj.optString("r3"),
        source = obj.optString("source")
    )
}
