---
state: todo
priority: low
size: small
tags:
  - sandbox
  - mitmproxy
---

# Use direct mitmproxy command to generate cert

Current Dockerfile bootstraps `mitmdump`, waits, then kills process just to force CA cert creation.

Follow-up:

- Find/document a direct mitmproxy command that generates `mitmproxy-ca-cert.pem` without backgrounding + polling.
- Replace the current workaround in `apps/os/sandbox/Dockerfile` in a separate PR.
