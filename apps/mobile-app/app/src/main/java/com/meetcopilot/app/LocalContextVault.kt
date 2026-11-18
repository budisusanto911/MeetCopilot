package com.meetcopilot.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Standalone on-device SQLite FTS4 vault for documents imported on the phone.
 */
class LocalContextVault(context: Context) :
    SQLiteOpenHelper(context, "meetcopilot_vault.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts4(source, content);")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS docs_fts;")
        onCreate(db)
    }

    fun indexDocument(fileName: String, text: String): Int {
        val clean = text.replace(Regex("\\r\\n?"), "\n").trim()
        if (clean.isEmpty()) return 0

        val words = clean.split(Regex("\\s+"))
        val chunks = mutableListOf<String>()
        var idx = 0
        while (idx < words.size) {
            val end = (idx + 130).coerceAtMost(words.size)
            chunks.add(words.subList(idx, end).joinToString(" "))
            if (end >= words.size) break
            idx += 110
        }

        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("docs_fts", "source = ?", arrayOf(fileName))
            for (chunk in chunks) {
                val values = ContentValues().apply {
                    put("source", fileName)
                    put("content", chunk)
                }
                db.insert("docs_fts", null, values)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return chunks.size
    }

    fun querySnippets(query: String, maxTokens: Int = TokenFrugalEngine.MAX_RAG_TOKENS, limit: Int = 3): List<String> {
        val terms = Regex("[A-Za-z0-9_]+")
            .findAll(query.lowercase())
            .map { it.value }
            .filter { it.length >= 2 }
            .distinct()
            .take(8)
            .toList()
        if (terms.isEmpty()) return emptyList()

        val matchExpr = terms.joinToString(" OR ")
        val db = readableDatabase
        val results = mutableListOf<String>()
        var usedTokens = 0

        db.rawQuery(
            "SELECT source, content FROM docs_fts WHERE docs_fts MATCH ? LIMIT ?",
            arrayOf(matchExpr, limit.toString())
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val source = cursor.getString(0)
                val content = cursor.getString(1)
                val entry = "[$source] $content"
                val tok = TokenFrugalEngine.estimateTokens(entry)
                if (usedTokens + tok > maxTokens) break
                results.add(entry)
                usedTokens += tok
            }
        }
        return results
    }

    fun clearAll() {
        writableDatabase.delete("docs_fts", null, null)
    }
}
