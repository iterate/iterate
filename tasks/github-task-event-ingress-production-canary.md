---
status: todo
---

# Automate the GitHub task-event production canary

Turn the 2026-07-14 manual production proof into a non-destructive scheduled
canary. A default-branch GitHub task-file change should be imported into the
Cloudflare Artifact and emit `repo/commit-completed` plus the corresponding
`repo/task-created`, `repo/task-updated`, or `repo/task-deleted` event from the
Artifact queue consumer.

The canary should verify the Artifact and GitHub commit OIDs converge and
record enough event metadata to distinguish webhook receipt, import, and queue
processing without creating a permanent task on every run.
