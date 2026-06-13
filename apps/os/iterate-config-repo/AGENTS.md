# Project Agent Notes

This private repo is the durable brain for the project's agents.

Agents should keep useful, stable project knowledge here: user preferences,
working agreements, product decisions, research summaries, unresolved questions,
and implementation notes that future agents should inherit. Prefer concise
markdown files that are easy to scan and update.

The project worker entrypoint is `worker.js`. The root project stream can call
`processEvent({ event, streamPath }, env)` on that worker for committed project
events.
