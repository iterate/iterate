---
title: Your iterate repo
category: Core concepts
---

# Your iterate repository

Every project comes with a git repository called `iterate-config`. It holds
your project's configuration and the code iterate runs on your behalf. Treat
it like code: versioned, reviewed, and rolled out by pushing.

## Structure

A fresh repository looks like this:

- `iterate.config.jsonc` — project configuration
- `package.json`
- `worker.js` — the project's root worker; it routes incoming requests to your
  apps
- `apps/<name>/worker.js` — one worker per app. New projects are seeded with
  two example apps and a `webhooks` app that records incoming webhooks to your
  project's event stream

## Workflow

1. Clone the repository — your project's Repos page in the dashboard shows the
   clone command and credentials
2. Edit, commit, and push to the default branch
3. iterate picks up new commits shortly after you push, rebuilds your
   project's worker, and serves the new version
