---
status: needs-grilling
size: medium
---

# Codemode script preamble — follow-ups

Deferred from #2431 (preamble `results` array + `setPreamble`). Field notes
from preview-5 testing, in Misha's words with initial takes.

- [ ] Eval for the preamble prompt: make sure agents actually reach for
      `results[0].data` / `.load(itx)` instead of re-fetching or re-pasting.
      _The field test caught one regression (fenced readFile recipe outcompeted
      the loader footnote) that an eval would have caught pre-merge._
- [ ] "Result" tab should show what the agent actually sees. Today it has its
      own truncation ("first 64 KB as YAML, no highlighting") that is a
      different mechanism from the history render (`scriptResultHistoryLimit`,
      spill, inferred-type + preview). One representation, the agent's.
- [ ] Why did the agent defensively `writeFile("sopranos-tvmaze-full.json", text)`
      and return `{ status, bytes, body: JSON.parse(text) }`? It didn't need
      the file OR the full body — the preamble keeps the result available.
      _Suspects: old docs/examples still teach the save-then-read pattern
      (itx examples, docs.search hits); the prompt says results are retained
      but doesn't say "so don't save copies". Audit examples + prompt line._
- [ ] Do we still need the spill-to-workspace process at all? Loaders read
      the settlement back through the host — more reliable (spill is
      best-effort, agent-door-only) and likely faster. The spill file's one
      remaining use is itx.workspace paging of huge text. Consider retiring
      the spill and pointing paging at `getScriptResult` too — would also
      delete the render's dual-pointer complexity.
