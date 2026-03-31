# logging

Inspired by https://loggingsucks.com and https://evlog.dev.

Core rules:

- all logging must happen inside `logger.run(async () => { ... })`
- logging outside a logger context is illegal and throws
- the logger only knows about `meta`, `messages`, `errors`, and `parent`
- everything else (`service`, `environment`, `request`, `user`, `outbox`, etc.) is application-level data set via `logger.set(...)`
- `logger.info` / `logger.debug` / `logger.warn` / `logger.error` append formatted strings to `messages`
- formatted message shape: `[INFO] 0.3s: user logged in`

Exit handling:

- `logger.onExit(handler)` can be registered globally or inside a specific `logger.run(...)`
- handlers receive the final wide log and can decide what to do with it
- helpers like pretty-printing, JSON output, keep filters, buffering, and dev log files are opt-in utilities; the logger core does not wire them up automatically

Notes:

- `tag-logger.ts` is an intentionally tiny shim so existing imports stay stable
- outbox-specific logging setup lives in `apps/os/backend/outbox/outbox-logging.ts`
