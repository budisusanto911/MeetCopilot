---
name: meeting-glossary-packer
description: >-
  Use this skill before a meeting to compress user-selected laptop folders or
  documents (PDF, DOCX, Markdown, TXT, code) into an ultra-compact cheat sheet
  under 450 tokens plus glossary trigger terms for MeetCopilot.
---

# Meeting Glossary Packer Skill

Compress large local project documents, CVs, or meeting notes into a compact `< 450` token static prefix cheat sheet so MeetCopilot stays context-aware while saving runtime RAG tokens.

## Steps

1. Run the packer script on target files or folders:
   `python3 .agents/skills/meeting-glossary-packer/scripts/pack_glossary.py --max-tokens 450 --json <path1> [path2 ...]`
2. Pass the returned `cheatSheet` and `glossaryTerms` to `POST /api/meeting/profile` (or let `POST /api/context/pack-glossary` apply it automatically).
3. Verify the returned `estimatedTokens` is `<= 450` and that no `.env`, `.key`, or secret files were included.
