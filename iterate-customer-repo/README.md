# Iterate customer repo (example)

This is a sample customer-repo layout with its own `pidnap.config.ts`.

What it does:

- Defines a pidnap scheduled process that runs every 3 hours.
- Directly triggers architect via daemon `POST /api/agents/:path` (no `iterate task` dependency).
- The monitoring logic lives in `skills/monitor-fly-io-usage/` with small focused playbooks.
