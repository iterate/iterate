iterate project config repo — `worker.ts` is the project worker. It handles
HTTP and declares packaged apps such as `GithubAiLinter`, `GuestbookApp`, and
`TodoApp`; project-owned app source lives under `apps/`. The packaged linter
reads this project's editable policy from `rules/`.
