# Task Grooming Guidelines

- **States**: `draft` (incomplete), `todo` (ready), `backlog` (deferred). Delete when done.
- **File paths**: Verify referenced files exist before committing task. Use `ls`/`find` to check.
- **Dependencies**: `dependsOn` must reference existing task files. Remove completed dependencies.
- **Subfolders**: Group related tasks (e.g., `tasks/observability/` for metrics/monitoring).
- **Thin tasks**: Acceptable for small items; flesh out before starting work if unclear.
- **Naming**: Descriptive kebab-case. No `ignoreme-` prefixes.
