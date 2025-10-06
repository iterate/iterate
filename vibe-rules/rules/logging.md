---
description: "Logging guidelines"
globs: ["apps/os/backend/**/*.ts"]
eslint:
  ignores: ["**/*test*/**", "**/*test*"]
  rules:
    no-console: "error"
---

- In general, logs in production are not looked at, so don't add them unless we specifically need them for debugging something.
- Do not use the `console` object, use the `logger` object from `apps/os/backend/tag-logger.ts`.
- Use logger.info instead of logger.log
