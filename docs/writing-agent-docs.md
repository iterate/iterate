# Writing agent docs

Repo root `AGENTS.md` and `CLAUDE.md` are symlinks to `README.md`. App and package folders may use the same pattern (`AGENTS.md` → `README.md`).

Guidelines:

- Keep agent-facing docs brief; sacrifice grammar for concision when needed.
- Prefer durable facts over prescriptive recipes ("XYZ lives in the database" beats "run this exact query" once the schema changes).
- Long sections belong in `docs/` or app-local docs, linked from the README table of contents.
