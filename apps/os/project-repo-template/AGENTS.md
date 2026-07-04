# Project Agent Notes

This private repo is the durable brain for the project's agents.

Agents should keep useful, stable project knowledge here: user preferences,
working agreements, product decisions, research summaries, unresolved questions,
and implementation notes that future agents should inherit. Prefer concise
markdown files that are easy to scan and update. Commit changes with
`itx.repo.commitFiles({ message, changes: [{ path, content }] })`.

The project worker entrypoint is `worker.ts` (TypeScript). Its default export
handles HTTP for the project's hosts, receives every committed project event
through `processEvent({ event })`, and reaches the project's capabilities
through `await this.env.ITX.get()`. The worker is built by the platform's
worker build pipeline: multi-file TypeScript works, and npm dependencies
declared in `package.json` (like `@slack/web-api`) are installed at build time.
`sdk.ts` is a snapshot of the platform's capability types (the future
`@iterate-com/sdk` package) taken when this repo was seeded — import types
from it, treat it as read-only.

The worker also exposes a Slack Web API surface backed by the real Slack SDK:
`itx.worker.slack.chat.postMessage({ channel, text })` (any nested Web API
method works). Configure it by committing `slack.config.ts`.
