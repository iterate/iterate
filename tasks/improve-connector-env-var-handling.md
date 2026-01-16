---
state: later
priority: medium
size: medium
tags:
  - architecture
  - core
---

# Improve connector env var handling

Right now when we get environment variables we also pull together API keys from the connectors table in `getEnv`. This doesn't scale well as it means getEnv needs to know about connector internals and is fairly brittle - each connector has its own way of storing/extracting.

A better approach would be to pre-generate & pre-fill environment variables into the env table from the connectors. This is mostly trivial for things that are long lived (e.g. the slack token), though it needs to be synched with connector state.

For things that need a refresh (short lived tokens), the platform needs some mechanism to understand when refreshing is needed & how to update the environment variables as part of this.
