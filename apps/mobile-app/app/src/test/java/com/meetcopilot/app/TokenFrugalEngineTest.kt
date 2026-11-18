package com.meetcopilot.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenFrugalEngineTest {
    @Test
    fun tier0DropsNoiseFillersAndResolvesCommonPhrases() {
        assertTrue(TokenFrugalEngine.evaluateTier0("uh-huh") is Tier0Decision.Drop)
        val mute = TokenFrugalEngine.evaluateTier0("You're on mute")
        assertTrue(mute is Tier0Decision.Instant)
        val real = TokenFrugalEngine.evaluateTier0("What is the API latency target?")
        assertTrue(real is Tier0Decision.CallLlm)
    }

    @Test
    fun ragGateSkipsSmalltalkAndExtractsKeywordsForTechnicalQuestions() {
        assertNull(TokenFrugalEngine.extractRagQuery("How are you?"))
        val query = TokenFrugalEngine.extractRagQuery("What is our database architecture and latency?")
        assertNotNull(query)
        assertTrue(query!!.contains("database"))
        assertTrue(query.contains("architecture"))
    }

    @Test
    fun wireParserExtractsStructuredFieldsAndStripsThinkTags() {
        val parsed = TokenFrugalEngine.parseWireOutput(
            "<think>plan</think>\nT|Bagaimana progres rilis?\nQ|1\nR1|On track.\nR2|All tests passed.\nR3|Web or mobile?"
        )
        assertEquals("Bagaimana progres rilis?", parsed.t)
        assertTrue(parsed.q)
        assertEquals("On track.", parsed.r1)
        assertEquals("All tests passed.", parsed.r2)
        assertEquals("Web or mobile?", parsed.r3)
    }
}
