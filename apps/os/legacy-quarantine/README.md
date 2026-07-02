# legacy-quarantine

Pre-migration (legacy itx engine) source held for the final phases of the
itx-v4 replacement (PR #1585). Nothing here compiles, deploys, or runs: the
folder is excluded from tsconfig, vitest, lint, and knip.

| Path                         | What                                                                                    | Why it is held                                                               | Way back                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `domains/slack/`             | Slack domain: webhook router, slack + slack-agent stream processors, Web API proxy, DOs | Phase 12 rebuilds Slack on the next engine; this is the behavioral reference | Rewrite processors new-style (`defineProcessorContract`/`StreamProcessor`), re-add slack workers to alchemy |
| `domains/google/`            | Gmail capability + Google OAuth token refresh                                           | Phase 12 restores Google integrations                                        | Re-home connection storage onto the next engine (D1 is gone)                                                |
| `domains/integration-api.ts` | OAuth connect/callback routes (`/api/*` integration surface)                            | Phase 12 restores the connect flows                                          | Re-mount under the Start catch-all route (`routes/api.$.ts`)                                                |

Everything else legacy (old itx engine, old domains, D1 schema, legacy worker
entries) was deleted in the same commit that added this folder — see that
commit's message for the inventory; `git show <sha>^:apps/os/src/...` retrieves
any of it.

Delete this folder in the endgame once Phase 12 lands.
