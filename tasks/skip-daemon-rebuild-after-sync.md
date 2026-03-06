---
state: backlog
priority: medium
size: small
tags:
  - sandbox
  - docker
  - performance
dependsOn: []
---

# Skip unnecessary daemon rebuild after host sync in local Docker provider

## Problem

After syncing from the host machine in the local Docker sandbox provider, the
daemon is always rebuilt. If the daemon was already built into the Docker image,
this rebuild on first machine start is redundant and really slow.

## Goal

- After host sync, determine whether the daemon binary actually changed.
- If unchanged (e.g. already baked into the image), skip the rebuild.
