---
status: ready
size: medium
---

# voice.iterate.com installs voice itself

**Status:** implemented, waiting on the PR preview to run the new spec.

- Done: installer moved to `apps/agents`, the voice page installs voice (key field + button), spec
  wired into PR previews beside Notes'.
- Left: the spec's first real run on the preview; then delete this file (iterate dropped `tasks/`).

## Why

voice.iterate.com is a browser phone for a project's voice agent. When the project has no voice
agent, it says "Open https://k.iterate.com and prepare this project to install voice". Kit's
Prepare is the only installer, and Kit only signs in to iterate's hosted platform
(`ITERATE_ORIGIN`). So a self-hosted platform has no way to get voice, even though voice.iterate.com
connects to self-hosts fine. People without a Kit board also get sent to a board flasher to use
their laptop mic.

Found while dogfooding self-hosting: voice was installed into a self-hosted project by hand, as a
`run` script that repeats Kit's `ensureVoiceAgent`. It worked: calls from the laptop answered.

## Decisions

- **The website asks for the OpenAI key**, not an agent. voice.iterate.com is already signed in to
  the project with the `iterate` scope, which is all Kit's Prepare uses. The key goes from the page
  straight to `/secrets/openai`, as Kit does it.
- **The website runs the install.** No-voice state becomes an "Install voice" form (an OpenAI key
  field when `/secrets/openai` is missing, then a button) that runs `ensureVoiceAgent` in the
  browser, then shows Call. Same pattern as the agents app installing its own runtime
  (`apps/agents/src/routes/_auth/projects.$slug.tsx`).
- **The install code moves next to what it installs.** It isn't Kit code: the manifest bundles
  `apps/agents/voice/*` and the agents runtime.
  - `apps/kit/src/voice/install.ts` → `apps/agents/voice/install.ts` (beside
    `apps/agents/runtime/install.ts`, which it already imports).
  - `apps/kit/scripts/build-voice-install.ts` → `apps/agents/scripts/build-voice-install.ts`
    (beside `build-runtime.ts`). `writeVoiceInstall(destination)` takes the file to write.
  - Each app builds and serves its own `public/voice-install.json` (Kit's stays, voice gains one),
    so neither depends on the other being up.
- **Kit keeps its Prepare** and imports the moved code. No behavior change there.
- **Detecting "installed"** is the `itx.voice` rewrite rule, as in `ensureVoiceAgent`. A rule that
  exists but fails health stays an error on Call (a broken custom service is not permission to
  replace it); that error no longer points at Kit.

## Checklist

- [x] Move `install.ts` and `build-voice-install.ts` into `apps/agents`; update Kit, the agents e2e
      tests (`kit-voice-install.e2e.test.ts` → `voice-install.e2e.test.ts`,
      `voice-agent.e2e.test.ts`) and READMEs. _Own commit; also added `fetchVoiceInstall()`, which
      Kit and voice share._
- [x] apps/voice builds `public/voice-install.json` in `vite.config.ts` (gitignored), as Kit does.
      _`writeVoiceInstall(destination)`; the build puts it in `dist/client`._
- [x] Voice page: the loader reads whether `itx.voice` is configured and whether `/secrets/openai`
      exists. Not installed → "Install voice" form. Installed → Call. _`InstallVoice` in
      `projects.$slug.tsx`._
- [x] Install runs `ensureVoiceAgent` with the signed-in project, loading `/voice-install.json`,
      then invalidates the route. _A form action via `useActionState`; no effects._
- [x] `call.ts`: the no-`itx.voice` error stops sending people to Kit. _Now "isn't answering",
      since Call only shows once installed._
- [x] Spec: `apps/voice/specs/voice.spec.ts` + `playwright.config.ts`, like
      `apps/notes/specs/notes.spec.ts`: sign in, create a project, install voice with a placeholder
      key, see Call. Run it from `apps/os/scripts/preview.ts` beside the notes spec when the voice
      preview deploys. _`scripts/ci/depot-workflows.test.ts` asserts the wiring, as for Notes._
- [x] READMEs: apps/voice (install lives here now), apps/kit (Prepare uses the shared installer).

## Out of scope

- Kit connecting to other platforms (it's hardwired to `ITERATE_ORIGIN`).
- Placing a real call in the spec (needs a real OpenAI key). Health returning `ok` is the proof,
  as in the existing install e2e.
