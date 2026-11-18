#!/usr/bin/env python3
"""
Compresses user-selected local files/folders into a < 450-token Meeting Cheat Sheet
and extracts domain glossary terms without duplicating file-extraction logic.
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
BRIDGE_SRC = REPO_ROOT / "apps" / "local-bridge" / "src"
sys.path.insert(0, str(BRIDGE_SRC))

from rag_indexer import estimate_tokens, extract_text, iter_allowed_files  # noqa: E402

ACRONYM_OR_TERM_RE = re.compile(r"\b(?:[A-Z]{2,}[A-Z0-9_-]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b")
HEADING_OR_BULLET_RE = re.compile(r"^(?:#{1,3}\s+|[-*]\s+)(.+)$")


def pack_paths(paths: list[str], max_tokens: int = 450) -> dict:
    files = iter_allowed_files(paths)
    lines: list[str] = []
    terms_freq: dict[str, int] = {}

    for fpath in files:
        raw = extract_text(fpath)
        if not raw.strip():
            continue

        # Collect domain terms / CamelCase / Acronyms
        for term in ACRONYM_OR_TERM_RE.findall(raw):
            if len(term) >= 2 and term not in {"THE", "AND", "FOR", "WITH", "HTTP", "HTTPS"}:
                terms_freq[term] = terms_freq.get(term, 0) + 1

        file_lines = []
        for raw_line in raw.splitlines():
            clean = raw_line.strip()
            if not clean:
                continue
            m = HEADING_OR_BULLET_RE.match(clean)
            if m:
                file_lines.append(m.group(1).strip())
            elif len(file_lines) < 3 and len(clean) >= 12:
                file_lines.append(clean)
            if len(file_lines) >= 5:
                break

        if file_lines:
            compact = " | ".join(file_lines)
            if len(compact) > 260:
                compact = compact[:257].rsplit(" ", 1)[0] + "..."
            lines.append(f"[{fpath.name}] {compact}")

    cheat_sheet_parts: list[str] = []
    used_tokens = 0
    for entry in lines:
        tok = estimate_tokens(entry) + 1
        if used_tokens + tok > max_tokens:
            remaining_chars = max(0, int((max_tokens - used_tokens) * 3.5))
            if remaining_chars >= 40:
                cheat_sheet_parts.append(entry[:remaining_chars].rsplit(" ", 1)[0] + "...")
            break
        cheat_sheet_parts.append(entry)
        used_tokens += tok

    cheat_sheet = "\n".join(cheat_sheet_parts)
    glossary_terms = [
        term
        for term, _count in sorted(terms_freq.items(), key=lambda kv: (-kv[1], kv[0]))[:20]
    ]

    return {
        "scannedFiles": len(files),
        "estimatedTokens": estimate_tokens(cheat_sheet),
        "maxTokens": max_tokens,
        "glossaryTerms": glossary_terms,
        "cheatSheet": cheat_sheet,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Pack local docs into compact meeting cheat sheet")
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--max-tokens", type=int, default=450)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    result = pack_paths(args.paths, max_tokens=args.max_tokens)
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result["cheatSheet"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
