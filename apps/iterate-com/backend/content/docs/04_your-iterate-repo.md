---
title: Your iterate repo
category: Core concepts
---

# Your iterate repository

Your iterate repo is where you store configuration, rules, and any custom tools. Treat it like code: versioned, reviewed, and deployed.

## Structure

- rules/: context rules for agents
- tools/: optional MCP clients or scripts
- iterate.config.ts: global configuration

## Workflow

1. Create a branch and make changes
2. Open a PR and gather review
3. Merge to main to roll out to agents
