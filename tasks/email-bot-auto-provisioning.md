---
state: in-progress
priority: high
size: large
dependsOn: []
tags:
  - email
  - outbox
  - machines
  - archil
  - onboarding
---

# Email Bot Auto-Provisioning

Auto-provision a full stack (user, org, project, Archil persistent disk, machine) when an unknown sender emails the bot address. Then forward the original email to the newly-active machine.

## User story

A normie emails `prd@mail.iterate.com`:

> "Send me a daily report of box office numbers for the top indie films in Europe"

They get an agent that persists state across machine reprovisioning via Archil (S3-backed POSIX volume).

## Decisions made

- **Bot address:** reuse existing `{stage}@{RESEND_BOT_DOMAIN}` format
- **Signup gating:** rely on existing `SIGNUP_ALLOWLIST` env var; emails not matching are dropped
- **Sandbox provider:** Fly (default)
- **Persistence:** Archil disk backed by Cloudflare R2, one R2 bucket with per-project prefix
- **Auto-wake:** no special handling; if machine is down, email is dropped (existing behaviour)
- **Naming:** `johnsmith@gmail.com` → org "johnsmith" / project "johnsmith" (mirrors existing first-project-gets-org-slug logic)

## Architecture

```
Resend webhook (unknown sender)
  │
  ▼  outbox event: email:received-unknown-sender
  │
  ├─► [createEmailBotUser]     → creates user (emailVerified=true)
  │     emits email:user-created
  │
  ├─► [createEmailBotOrg]      → creates org + membership
  │     emits email:org-created
  │
  ├─► [createEmailBotProject]  → creates project
  │     emits email:project-created
  │
  ├─► [provisionEmailBotInfra] → Archil disk + createMachineForProject()
  │     enters existing machine pipeline:
  │       machine:created → provisionMachine
  │       machine:daemon-status-reported → pushMachineSetup
  │       machine:setup-pushed → sendReadinessProbe
  │       machine:probe-succeeded → activateMachine
  │       machine:activated → forwardPendingEmail (new)
  │
  └─► [forwardPendingEmail]    → fetches stored email, forwards to daemon
```

## File changes

### New files

| File                                                 | Purpose                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/os/backend/integrations/archil/archil.ts`      | Archil API client + `ensureProjectArchilDisk()` (platform-level, every project) |
| `apps/os/backend/services/email-bot-provisioning.ts` | Auto-provision service: user/org/project/machine creation from email            |

### Modified files

| File                                            | Change                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/os/backend/outbox/client.ts`              | Add 5 email-bot event types                                                     |
| `apps/os/backend/outbox/consumers.ts`           | Add 5 email-bot consumers                                                       |
| `apps/os/backend/integrations/resend/resend.ts` | Emit `email:received-unknown-sender` for unknown senders instead of dropping    |
| `apps/os/backend/services/machine-creation.ts`  | Call `ensureProjectArchilDisk()` for every machine (platform-level persistence) |
| `apps/os/alchemy.run.ts`                        | Add `ARCHIL_*` env vars                                                         |
| `sandbox/Dockerfile`                            | Install archil client                                                           |
| `sandbox/entry.sh`                              | Mount/unmount Archil disk when env vars present                                 |

## Env vars

### Doppler (manual)

| Var              | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `ARCHIL_API_KEY` | Archil control plane API key (`key-...`) |
| `ARCHIL_REGION`  | Archil region, default `us-east-1`       |

### Alchemy-managed (auto-provisioned)

| Binding                       | Source                       |
| ----------------------------- | ---------------------------- |
| `ARCHIL_R2_BUCKET_NAME`       | `R2Bucket("archil-data")`    |
| `ARCHIL_R2_ENDPOINT`          | CF account R2 S3 endpoint    |
| `ARCHIL_R2_ACCESS_KEY_ID`     | `AccountApiToken` access key |
| `ARCHIL_R2_SECRET_ACCESS_KEY` | `AccountApiToken` secret key |

## Idempotency

Every consumer must handle retries:

- `createEmailBotUser`: skip if user with email already exists
- `createEmailBotOrg`: skip if user already has an org
- `createEmailBotProject`: skip if org already has a project
- `provisionEmailBotInfra`: skip if project already has a machine
- `forwardPendingEmail`: existing resendEmailId dedup on daemon side

## Open items / follow-ups

- [ ] Archil account signup + API key in Doppler
- [ ] R2 bucket creation (`iterate-email-bot-data` or similar)
- [ ] Rate limiting / abuse prevention beyond allowlist
- [ ] What happens when a user's second email arrives while machine is still provisioning (queue? drop?)
- [ ] Email reply-to address so the user can reply to the agent's responses
- [ ] Admin UI for email-bot users
