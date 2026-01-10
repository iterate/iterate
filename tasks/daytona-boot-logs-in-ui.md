---
state: next
tags:
  - daytona
  - os2
  - infrastructure
priority: medium
certainty: low
size: medium
---

# Daytona machine boot logs in OS2 UI

When a Daytona machine boots, we should be able to see logs of the boot process and entry point running in the OS2 UI.

## What we need

- Stream/display logs from Daytona machine boot process
- Show entry point execution logs
- Make this visible somewhere sensible in the OS2 UI

## Open questions (needs design chat)

- Where in the UI should these logs appear?
- Should this be a dedicated view, a panel, or integrated into an existing workspace view?
- How do we get these logs from Daytona? (API, websocket stream, polling?)
- What level of detail do we want to show?
- Should logs persist or just show real-time?
