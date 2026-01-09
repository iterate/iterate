---
description: "Logging guidelines"
globs: ["apps/*/backend/**/*.ts"]
eslint:
  ignores: ["**/*test*/**", "**/*test*", "**/*e2e*"]
  rules:
    no-console: "error"
---

- In general, logs in production are not looked at, so don't add them unless we specifically need them for debugging something.
- Do not use the `console` object, use the `logger` object from the app's `backend/tag-logger.ts`.
- Use logger.info instead of logger.log
