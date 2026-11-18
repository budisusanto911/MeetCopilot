package com.meetcopilot.app

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class CopilotUiState(
    val companionConnected: Boolean = false,
    val micListening: Boolean = false,
    val micPausedSelfSpeaking: Boolean = false,
    val overlayRunning: Boolean = false,
    val activeProvider: String = "Tier-0",
    val statusText: String = "Siap mendampingi meeting",
    val turns: List<TurnEntry> = emptyList()
)

object CopilotStateBus {
    private val _state = MutableStateFlow(CopilotUiState())
    val state: StateFlow<CopilotUiState> = _state.asStateFlow()

    fun update(transform: (CopilotUiState) -> CopilotUiState) {
        _state.value = transform(_state.value)
    }

    fun upsertTurn(entry: TurnEntry) {
        update { current ->
            val filtered = current.turns.filterNot { it.id == entry.id }
            current.copy(
                turns = (listOf(entry) + filtered).take(30),
                activeProvider = entry.providerUsed.ifBlank { current.activeProvider }
            )
        }
    }
}
