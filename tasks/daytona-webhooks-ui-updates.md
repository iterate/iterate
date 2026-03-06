---
state: todo
tags:
  - daytona
  - infrastructure
---

# Consume Daytona Webhooks and Update UI

Implement webhook consumption from Daytona to receive real-time updates about workspace and sandbox state changes, then propagate those updates to the UI.

## Requirements

- Set up webhook endpoint to receive Daytona events
- Parse and validate incoming webhook payloads
- Update relevant database state based on webhook events
- Push updates to connected clients via realtime (Pusher)
- Handle webhook authentication/verification
