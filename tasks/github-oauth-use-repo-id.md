---
state: backlog
priority: medium
size: small
tags:
  - github
  - posthog
  - analytics
dependsOn: []
---

# Use GitHub repo ID for OAuth + PostHog distinct_id

## Problem

We currently use `owner/name` for GitHub repo identification in PostHog and
connection logic. This is brittle on renames/transfers and can cause ambiguous
matches. Webhook payloads include `repository.id`, which is stable.

## Goal

- Use `repository.id` everywhere (OAuth connect flow, storage, webhook distinct_id).
- Update PostHog `linkExternalIdToGroups` to use `github:${repoId}`.
- Decide whether/how to migrate existing associations.

## Notes

- OAuth already has `repoId` in `project.ts`.
- Webhook payload contains `repository.id`.
