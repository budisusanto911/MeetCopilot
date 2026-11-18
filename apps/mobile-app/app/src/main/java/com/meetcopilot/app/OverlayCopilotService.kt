package com.meetcopilot.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Draggable Floating Overlay (SYSTEM_ALERT_WINDOW) displaying the latest Indonesian
 * translation and tap-to-copy English reply chips above Meet / Zoom / Teams apps.
 */
class OverlayCopilotService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var windowManager: WindowManager
    private var rootView: LinearLayout? = null
    private lateinit var translationView: TextView
    private lateinit var replyContainer: LinearLayout

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForegroundNotification()
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        createFloatingView()
        CopilotStateBus.update { it.copy(overlayRunning = true) }

        scope.launch {
            CopilotStateBus.state.collect { state ->
                val latest = state.turns.firstOrNull()
                if (latest == null) {
                    translationView.text = "MeetCopilot Overlay aktif — menunggu ucapan..."
                    replyContainer.removeAllViews()
                } else {
                    translationView.text = latest.result.t.ifBlank { latest.utterance }
                    renderReplyChips(latest.result)
                }
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        rootView?.let { runCatching { windowManager.removeView(it) } }
        rootView = null
        CopilotStateBus.update { it.copy(overlayRunning = false) }
        super.onDestroy()
    }

    private fun startForegroundNotification() {
        val channelId = "meetcopilot_overlay"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                "MeetCopilot Overlay",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val notification = builder
            .setContentTitle("MeetCopilot Aktif")
            .setContentText("Overlay terjemahan & opsi jawaban berjalan")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .build()

        startForeground(101, notification)
    }

    private fun createFloatingView() {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 18, 24, 18)
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#E60F172A"))
                cornerRadius = 24f
                setStroke(2, Color.parseColor("#38BDF8"))
            }
        }

        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val title = TextView(this).apply {
            text = "MeetCopilot (Geser)"
            setTextColor(Color.parseColor("#38BDF8"))
            textSize = 11f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val closeBtn = TextView(this).apply {
            text = " ✕ "
            setTextColor(Color.parseColor("#FCA5A5"))
            textSize = 14f
            setOnClickListener { stopSelf() }
        }
        headerRow.addView(title)
        headerRow.addView(closeBtn)

        translationView = TextView(this).apply {
            text = "Menunggu ucapan..."
            setTextColor(Color.WHITE)
            textSize = 13.5f
            setPadding(0, 8, 0, 8)
        }

        replyContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }

        layout.addView(headerRow)
        layout.addView(translationView)
        layout.addView(replyContainer)

        val overlayType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        val params = WindowManager.LayoutParams(
            780,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 40
            y = 180
        }

        attachDragListener(headerRow, params)
        windowManager.addView(layout, params)
        rootView = layout
    }

    private fun renderReplyChips(result: CopilotResult) {
        replyContainer.removeAllViews()
        val chips = listOf(
            "1·Quick: " to result.r1,
            "2·Detail: " to result.r2,
            "3·Clarify: " to result.r3
        ).filter { it.second.isNotBlank() }

        for ((prefix, replyText) in chips) {
            val chip = TextView(this).apply {
                text = "$prefix$replyText"
                setTextColor(Color.parseColor("#E2E8F0"))
                textSize = 12f
                setPadding(14, 10, 14, 10)
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#1E293B"))
                    cornerRadius = 14f
                }
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = 8 }
                setOnClickListener {
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("MeetCopilot Reply", replyText))
                    Toast.makeText(this@OverlayCopilotService, "Jawaban disalin", Toast.LENGTH_SHORT).show()
                }
            }
            replyContainer.addView(chip)
        }
    }

    private fun attachDragListener(handle: View, params: WindowManager.LayoutParams) {
        var initialX = 0
        var initialY = 0
        var touchX = 0f
        var touchY = 0f
        handle.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = params.x
                    initialY = params.y
                    touchX = event.rawX
                    touchY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    params.x = initialX + (event.rawX - touchX).toInt()
                    params.y = initialY + (event.rawY - touchY).toInt()
                    rootView?.let { windowManager.updateViewLayout(it, params) }
                    true
                }
                else -> false
            }
        }
    }
}
