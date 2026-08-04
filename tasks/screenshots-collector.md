---
status: needs-grilling
size: large
tags: [mobile, files, processors, ai]
---

# Screenshots collector

A photo-library collector built on iterate: the mobile app gains full photo-library access, syncs photos into a project's file storage in the background, and a per-project rules pipeline processes each photo with cheap-first layers (metadata → screenshot heuristics → OCR/small models via `itx.ai.run` → LLM agent only for photos that earn it). Rules are user-configurable, e.g. "screenshot of an X post → find the post URL, capture the text, categorise as 'interesting tech articles'".

Being fleshed out via a grill-you interview; transcript will land alongside this file.
