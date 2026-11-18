package com.meetcopilot.app

import kotlin.math.ceil

data class CopilotResult(
    val t: String = "",
    val q: Boolean = false,
    val r1: String = "",
    val r2: String = "",
    val r3: String = "",
    val source: String = ""
)

data class TurnEntry(
    val id: String,
    val utterance: String,
    val result: CopilotResult,
    val providerUsed: String = "",
    val usedRag: Boolean = false
)

sealed class Tier0Decision {
    data class Drop(val reason: String) : Tier0Decision()
    data class Instant(val result: CopilotResult) : Tier0Decision()
    data class CallLlm(val normalized: String) : Tier0Decision()
}

object TokenFrugalEngine {
    const val MAX_OUTPUT_TOKENS = 180
    const val MAX_RAG_TOKENS = 380

    private val noiseFillers = setOf(
        "uh", "um", "umm", "hmm", "hm", "er", "erm", "ah", "oh",
        "uh huh", "uh-huh", "mm hmm", "mm-hmm", "mhm", "huh"
    )

    private val instantPhrases = mapOf(
        "hello" to CopilotResult("Halo.", true, "Hi everyone, good to be here.", "Hi! Thanks for having me, can you hear me clearly?", "Hello! Checking if my audio is clear.", "tier0-phrase"),
        "can you hear me" to CopilotResult("Suara saya kedengaran?", true, "Yes, I can hear you loud and clear.", "Yes, your audio is clear on my side. How about mine?", "I can hear you, though slightly faint.", "tier0-phrase"),
        "you are on mute" to CopilotResult("Mikrofon kamu masih mute.", true, "Oh sorry, let me unmute myself.", "Thanks for flagging! Can you hear me now?", "Oops, my bad—I am unmuted now.", "tier0-phrase"),
        "youre on mute" to CopilotResult("Mikrofon kamu masih mute.", true, "Oh sorry, let me unmute myself.", "Thanks for flagging! Can you hear me now?", "Oops, my bad—I am unmuted now.", "tier0-phrase"),
        "thank you" to CopilotResult("Terima kasih.", false, "You're welcome!", "Happy to help—let me know if you need anything else.", "Anytime!", "tier0-phrase"),
        "got it" to CopilotResult("Siap, paham.", false, "Great.", "Awesome, glad we are aligned.", "Sounds good, feel free to continue.", "tier0-phrase")
    )

    private val contextTriggerRegex = Regex(
        """\b(what|how|when|why|which|where|who|explain|describe|status|progress|update|timeline|deadline|milestone|budget|metric|architecture|stack|database|api|deploy|release|latency|experience|resume|cv|project|feature|client|document|report)\b""",
        RegexOption.IGNORE_CASE
    )

    private val stopWords = setOf(
        "a", "an", "the", "is", "are", "was", "were", "be", "have", "has", "do", "does",
        "did", "will", "would", "could", "should", "can", "i", "you", "we", "they", "it",
        "my", "your", "our", "this", "that", "to", "of", "in", "on", "at", "for", "with",
        "about", "from", "by", "and", "or", "but", "just", "me", "us", "please"
    )

    fun estimateTokens(text: String): Int {
        val clean = text.trim()
        if (clean.isEmpty()) return 0
        return ceil(clean.length / 3.7).toInt().coerceAtLeast(1)
    }

    fun evaluateTier0(rawText: String): Tier0Decision {
        val normalized = rawText.replace(Regex("\\s+"), " ").trim()
        if (normalized.isEmpty()) return Tier0Decision.Drop("empty")

        val key = normalized.lowercase()
            .replace("'", "")
            .replace("’", "")
            .replace(Regex("[.,!?;:]+$"), "")
            .trim()

        if (key.length < 2 || key in noiseFillers) {
            return Tier0Decision.Drop("noise_filler")
        }

        instantPhrases[key]?.let { return Tier0Decision.Instant(it) }
        return Tier0Decision.CallLlm(normalized)
    }

    fun extractRagQuery(utterance: String): String? {
        val clean = utterance.trim()
        if (clean.split(Regex("\\s+")).size <= 3 && !clean.contains("?")) return null
        if (!contextTriggerRegex.containsMatchIn(clean) && !clean.contains("?")) return null

        val keywords = clean.lowercase()
            .replace(Regex("[^a-z0-9_\\s-]"), " ")
            .split(Regex("\\s+"))
            .filter { it.length >= 2 && it !in stopWords }
            .distinct()
            .take(8)

        return if (keywords.isEmpty()) null else keywords.joinToString(" ")
    }

    fun buildSystemPrompt(userGoal: String = "", cheatSheet: String = ""): String {
        return buildString {
            appendLine("You are MeetCopilot, a live bilingual meeting assistant (Foreign -> Natural Indonesian).")
            appendLine("Keep technical terms intact. Output EXACTLY 5 single-line fields, no extra text:")
            appendLine("T|<natural Indonesian translation>")
            appendLine("Q|<1 if reply expected, 0 otherwise>")
            appendLine("R1|<short direct English reply, 1 sentence>")
            appendLine("R2|<detailed context-grounded English reply, 1-2 sentences>")
            append("R3|<polite clarifying or buy-time English reply>")
            if (userGoal.isNotBlank()) {
                append("\n\nMEETING_ROLE: ").append(userGoal.take(180))
            }
            if (cheatSheet.isNotBlank()) {
                append("\n\nCHEAT_SHEET:\n").append(cheatSheet.take(1400))
            }
        }
    }

    fun buildUserPrompt(
        utterance: String,
        recentTurns: List<TurnEntry>,
        ragSnippets: List<String>
    ): String {
        return buildString {
            if (recentTurns.isNotEmpty()) {
                appendLine("RECENT:")
                recentTurns.takeLast(4).forEach { turn ->
                    append("SPK: ").append(turn.utterance.take(120)).appendLine()
                }
                appendLine()
            }
            if (ragSnippets.isNotEmpty()) {
                appendLine("CTX:")
                ragSnippets.forEach { appendLine(it) }
                appendLine()
            }
            append("U: ").append(utterance.take(700))
        }
    }

    fun parseWireOutput(rawText: String): CopilotResult {
        val cleaned = rawText
            .replace(Regex("<think>[\\s\\S]*?</think>", RegexOption.IGNORE_CASE), "")
            .replace(Regex("<think>[\\s\\S]*$", RegexOption.IGNORE_CASE), "")
            .replace(Regex("^```[^\\n]*\\n?", RegexOption.MULTILINE), "")
            .replace("```", "")

        var t = ""
        var q = false
        var r1 = ""
        var r2 = ""
        var r3 = ""
        val lineRe = Regex("^(T|Q|R1|R2|R3)\\s*[:|]\\s*(.*)$", RegexOption.IGNORE_CASE)

        for (rawLine in cleaned.lines()) {
            val line = rawLine.trim()
            if (line.isEmpty()) continue
            val m = lineRe.matchEntire(line) ?: continue
            val value = m.groupValues[2].trim()
            when (m.groupValues[1].uppercase()) {
                "T" -> t = value
                "Q" -> q = value == "1" || value.equals("true", true) || value.equals("yes", true)
                "R1" -> r1 = value
                "R2" -> r2 = value
                "R3" -> r3 = value
            }
        }

        if (t.isBlank() && cleaned.isNotBlank()) {
            t = cleaned.trim()
        }
        return CopilotResult(t = t, q = q, r1 = r1, r2 = r2, r3 = r3)
    }
}
