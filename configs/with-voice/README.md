# Voice project configuration

This is the second checked-in config repository template. Its `worker.ts`
serves a small voice demo that speaks entered text with the browser's speech
synthesis API and retains a plain-text fallback when that API is unavailable.

Create a project from this template with a public GitHub reference such as:

```text
github:iterate/iterate#main&path:configs/with-voice
```

Iterate resolves the ref to one commit and copies this directory into a fresh
project config repository. The project does not remain linked to this source.

This template opts into onboarding entirely in `worker.ts`: its
`project/created` case creates `/agents/onboarding`, installs this repo's
voice-specific `ONBOARDING.md`, starts the first agent turn, and opens the
agent on each connected OS browser client that is still on the new project's
landing page. Removing that case removes the behavior without changing OS.
