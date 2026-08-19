- 2026-08-19 (preview review): codemode-tag birth-reaction ordering fix —
  the AGENTS.md sync ran AFTER the conversion batch whose last event lowers
  the debounce (the release), so first turns raced AGENTS.md and its
  application looked inconsistent across agents (preview p1759). Sync now
  runs first, release stays last — matching the default template's order.
