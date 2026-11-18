#!/usr/bin/env python3
"""
Privacy-first local document indexer and FTS5 retriever for MeetCopilot.
Indexes user-allowed folders into SQLite FTS5 with strict sensitive-file exclusions
and token-budgeted Top-K snippet retrieval.
"""

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

BLOCKED_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", ".ssh",
    ".gnupg", ".aws", ".kube", ".vault", "dist", "build", ".next",
    ".gradle", ".dart_tool", ".idea"
}

BLOCKED_NAME_RE = re.compile(
    r"(^|/)\.env(\.|$)|"
    r"(^|/)\.(npmrc|netrc)$|"
    r"\.(pem|key|p8|p12|pfx|crt|cer|der|jks|keystore|db|sqlite|sqlite3)$|"
    r"(^|/)(id_rsa|id_ed25519|id_ecdsa|credentials|secrets?|service[-_]?account.*)(\.|$)",
    re.IGNORECASE,
)

SUPPORTED_EXTS = {
    ".md", ".markdown", ".txt", ".pdf", ".docx", ".csv",
    ".json", ".yaml", ".yml", ".rst", ".py", ".js", ".mjs",
    ".ts", ".tsx", ".kt", ".java", ".dart", ".go", ".rs"
}

MAX_FILE_BYTES = 5 * 1024 * 1024  # 5 MB safety cap per file


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, int(len(text.strip()) / 3.7) + 1)


def is_blocked_path(path: Path) -> bool:
    parts = set(path.parts)
    if parts & BLOCKED_DIRS:
        return True
    norm = path.as_posix()
    return bool(BLOCKED_NAME_RE.search(norm))


def extract_pdf_text(path: Path) -> str:
    pdftotext = shutil.which("pdftotext")
    if not pdftotext:
        return ""
    try:
        res = subprocess.run(
            [pdftotext, "-layout", "-nopgbrk", str(path), "-"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return res.stdout if res.returncode == 0 else ""
    except (subprocess.SubprocessError, OSError):
        return ""


def extract_docx_text(path: Path) -> str:
    try:
        with zipfile.ZipFile(path, "r") as zf:
            if "word/document.xml" not in zf.namelist():
                return ""
            xml_bytes = zf.read("word/document.xml")
        root = ET.fromstring(xml_bytes)
        paragraphs = []
        for p in root.iter():
            if p.tag.endswith("}p"):
                texts = [t.text for t in p.iter() if t.tag.endswith("}t") and t.text]
                if texts:
                    paragraphs.append("".join(texts))
        return "\n".join(paragraphs)
    except (zipfile.BadZipFile, ET.ParseError, OSError):
        return ""


def extract_text(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return extract_pdf_text(path)
    if ext == ".docx":
        return extract_docx_text(path)
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def chunk_text(text: str, max_words: int = 135, overlap_words: int = 20) -> list[str]:
    cleaned = re.sub(r"\r\n?", "\n", text or "")
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    if not cleaned:
        return []

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", cleaned) if p.strip()]
    chunks = []
    current_words: list[str] = []

    for para in paragraphs:
        words = para.split()
        if not words:
            continue
        if len(current_words) + len(words) <= max_words:
            current_words.extend(words)
            continue

        if current_words:
            chunks.append(" ".join(current_words))
            tail = current_words[-overlap_words:] if overlap_words > 0 else []
            current_words = list(tail)

        while len(words) > max_words:
            chunks.append(" ".join(words[:max_words]))
            step = max(1, max_words - overlap_words)
            words = words[step:]

        current_words.extend(words)

    if current_words:
        chunks.append(" ".join(current_words))

    return chunks


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS docs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            file_name TEXT NOT NULL,
            mtime REAL NOT NULL,
            size INTEGER NOT NULL,
            chunk_count INTEGER NOT NULL
        );
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
            chunk_idx INTEGER NOT NULL,
            content TEXT NOT NULL
        );
        """
    )
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            content,
            content='chunks',
            content_rowid='id',
            tokenize='porter unicode61'
        );
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;
        """
    )
    conn.commit()


def iter_allowed_files(paths: list[str]) -> list[Path]:
    found: list[Path] = []
    seen: set[str] = set()
    for raw in paths:
        target = Path(raw).expanduser().resolve()
        if not target.exists():
            continue
        if target.is_file():
            if (
                not is_blocked_path(target)
                and target.suffix.lower() in SUPPORTED_EXTS
                and target.stat().st_size <= MAX_FILE_BYTES
            ):
                key = str(target)
                if key not in seen:
                    seen.add(key)
                    found.append(target)
            continue

        for root, dirs, files in os.walk(target):
            dirs[:] = [d for d in dirs if d not in BLOCKED_DIRS and not d.startswith(".git")]
            root_path = Path(root)
            for fname in files:
                fpath = root_path / fname
                if is_blocked_path(fpath):
                    continue
                if fpath.suffix.lower() not in SUPPORTED_EXTS:
                    continue
                try:
                    if fpath.stat().st_size > MAX_FILE_BYTES:
                        continue
                except OSError:
                    continue
                key = str(fpath)
                if key not in seen:
                    seen.add(key)
                    found.append(fpath)
    return sorted(found)


def cmd_index(db_path: Path, paths: list[str]) -> dict:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys=ON;")
    ensure_schema(conn)

    files = iter_allowed_files(paths)
    indexed = 0
    skipped_unchanged = 0
    total_chunks_written = 0

    for fpath in files:
        stat = fpath.stat()
        spath = str(fpath)
        existing = conn.execute(
            "SELECT id, mtime, size FROM docs WHERE path = ?",
            (spath,),
        ).fetchone()

        if existing and abs(existing[1] - stat.st_mtime) < 1e-6 and existing[2] == stat.st_size:
            skipped_unchanged += 1
            continue

        text = extract_text(fpath)
        chunks = chunk_text(text)
        if existing:
            conn.execute("DELETE FROM docs WHERE id = ?", (existing[0],))

        if not chunks:
            continue

        cur = conn.execute(
            "INSERT INTO docs(path, file_name, mtime, size, chunk_count) VALUES(?, ?, ?, ?, ?)",
            (spath, fpath.name, stat.st_mtime, stat.st_size, len(chunks)),
        )
        doc_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO chunks(doc_id, chunk_idx, content) VALUES(?, ?, ?)",
            [(doc_id, idx, chunk) for idx, chunk in enumerate(chunks)],
        )
        indexed += 1
        total_chunks_written += len(chunks)

    conn.commit()
    stats = get_stats_dict(conn)
    conn.close()
    return {
        "ok": True,
        "scannedFiles": len(files),
        "indexedFiles": indexed,
        "skippedUnchanged": skipped_unchanged,
        "chunksWritten": total_chunks_written,
        **stats,
    }


def sanitize_fts_query(query: str) -> str:
    tokens = re.findall(r"[A-Za-z0-9_]+", query or "")
    unique: list[str] = []
    for tok in tokens:
        low = tok.lower()
        if len(low) >= 2 and low not in unique:
            unique.append(low)
            if len(unique) >= 10:
                break
    return " OR ".join(f'"{t}"' for t in unique)


def cmd_query(db_path: Path, query: str, max_tokens: int, limit: int) -> dict:
    if not db_path.exists():
        return {"ok": True, "snippets": [], "usedTokens": 0}

    fts_query = sanitize_fts_query(query)
    if not fts_query:
        return {"ok": True, "snippets": [], "usedTokens": 0}

    conn = sqlite3.connect(str(db_path))
    ensure_schema(conn)
    rows = conn.execute(
        """
        SELECT d.file_name, d.path, c.content, bm25(chunks_fts) AS rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        JOIN docs d ON d.id = c.doc_id
        WHERE chunks_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
        """,
        (fts_query, max(1, limit * 2)),
    ).fetchall()
    conn.close()

    snippets = []
    used_tokens = 0
    seen_snippets: set[str] = set()

    for file_name, full_path, content, rank in rows:
        if content in seen_snippets:
            continue
        tok = estimate_tokens(content) + 8
        if snippets and used_tokens + tok > max_tokens:
            continue
        if used_tokens + tok > max_tokens:
            max_chars = max(40, int((max_tokens - used_tokens) * 3.5))
            content = content[:max_chars].rsplit(" ", 1)[0].strip() + "..."
            tok = estimate_tokens(content) + 8
        if used_tokens + tok > max_tokens:
            break

        seen_snippets.add(content)
        snippets.append(
            {
                "source": file_name,
                "path": full_path,
                "snippet": content,
                "score": round(float(rank), 4),
            }
        )
        used_tokens += tok
        if len(snippets) >= limit:
            break

    return {"ok": True, "snippets": snippets, "usedTokens": used_tokens}


def get_stats_dict(conn: sqlite3.Connection) -> dict:
    doc_count = conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
    chunk_count = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    return {"totalDocs": doc_count, "totalChunks": chunk_count}


def cmd_stats(db_path: Path) -> dict:
    if not db_path.exists():
        return {"ok": True, "totalDocs": 0, "totalChunks": 0}
    conn = sqlite3.connect(str(db_path))
    ensure_schema(conn)
    stats = get_stats_dict(conn)
    conn.close()
    return {"ok": True, **stats}


def cmd_clear(db_path: Path) -> dict:
    if db_path.exists():
        db_path.unlink()
    for suffix in ("-wal", "-shm"):
        sidecar = Path(f"{db_path}{suffix}")
        if sidecar.exists():
            sidecar.unlink()
    return {"ok": True, "totalDocs": 0, "totalChunks": 0}


def main() -> int:
    parser = argparse.ArgumentParser(description="MeetCopilot Local FTS5 RAG Indexer")
    parser.add_argument("--db", required=True, help="Path to SQLite DB file")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_idx = sub.add_parser("index")
    p_idx.add_argument("paths", nargs="+")

    p_qry = sub.add_parser("query")
    p_qry.add_argument("--q", required=True)
    p_qry.add_argument("--max-tokens", type=int, default=420)
    p_qry.add_argument("--limit", type=int, default=3)

    sub.add_parser("stats")
    sub.add_parser("clear")

    args = parser.parse_args()
    db_path = Path(args.db).expanduser().resolve()

    if args.cmd == "index":
        out = cmd_index(db_path, args.paths)
    elif args.cmd == "query":
        out = cmd_query(db_path, args.q, args.max_tokens, args.limit)
    elif args.cmd == "stats":
        out = cmd_stats(db_path)
    else:
        out = cmd_clear(db_path)

    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
