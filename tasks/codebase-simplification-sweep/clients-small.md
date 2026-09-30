# Sweep candidates: clients-small

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## configs/heartbeat is a full copy of configs/default plus one 8-line schedule: delete it and document the schedule

- Sweep index: 79; risk: low; payoff: 4/10
- LOC: About −177: configs/heartbeat −166, tests about −12, README −2, AGENTS.md +3. (skeptic measured: I measured on origin/main b3daf4846.
- configs/heartbeat has 170 tracked lines, not 166: AGENTS.md 53, worker.ts 87, package.json 14, tsconfig.json 14, agents.ts 1, voice.ts 1.
- I drafted the test edits in the scratchpad (hb/dt.new.ts, hb/tt.new.ts).
  - default-template.test.ts goes from 229 to 201 lines (−28).
  - templates.test.ts goes from 352 to 346 lines (−6).
- configs/README.md loses 2 lines, and configs/default/AGENTS.md gains about 1.
- package.json:10 and the comment at apps/agents/e2e/template.e2e.test.ts:28 are edited in place, so their line counts stay the same.
- Net is about −205 LOC across 11 files: 6 deleted, 5 edited.
- knip.ts and the .depot workflow path filters use `configs/*` globs, so they need no change.
- PR #3446 touches nothing under configs/ and neither template test.)
- Concepts: Three templates with two copies of the init/email code become two templates with one copy, plus a documented one-liner.

### Evidence

Merges the parallel and heavy hunts.

configs/heartbeat is 166 lines. Its package.json, tsconfig.json, agents.ts and voice.ts are byte-identical to configs/default (checked with cmp). worker.ts differs only at :17-24, the itx.schedules.set block, and AGENTS.md differs in 3-4 lines.

The email case is duplicated at default/worker.ts:22-63 and heartbeat/worker.ts:30-71. The email rows in default-template.test.ts:46-100 run only against DefaultTemplate, so the heartbeat copy is untested and will drift silently.

The folder was created in #3425 (8c568dbf2), and #3442 has since edited it in lockstep. Its wiring:

- package.json:10 typecheck:configs
- default-template.test.ts:7 and :10-22
- templates.test.ts:37-49
- configs/README.md:14-15
- default/AGENTS.md:15
- apps/agents/e2e/template.e2e.test.ts:28

### Current shape

Three templates ship. heartbeat is default copied whole to add one `itx.schedules.set` in the init case, so every change to the default must be made twice.

### Proposed shape

Delete configs/heartbeat. configs/default/AGENTS.md then shows the call instead:

```md
The project sets no schedule, so an idle project sleeps. To wake it every five minutes, add to the init case
`await itx.schedules.set({ key: "heartbeat", when: { everyMs: 5 * 60_000 }, events: [{ type: "heartbeat" }] })`;
`itx.schedules.cancel("heartbeat")` stops it.
```

Also:

- Drop the heartbeat test row.
- Point templates.test.ts's preset test at Minimal.
- Drop it from typecheck:configs and the README.

### What changes

- The template picker and the PR quick-launch links lose 'Heartbeat'.
- Existing projects are unaffected, because a project owns its config repo.
- `github:iterate/iterate#<old sha>&path:configs/heartbeat` still works.
- This undoes a preset #3425 added on purpose today, so it is the owner's call.

### Pinned by

- apps/os/src/project/default-template.test.ts:10-44 (the heartbeat row)
- templates.test.ts:38-49 (label 'Heartbeat')
- package.json:10

### Skeptic's amended proposal

Delete configs/heartbeat (6 files, 170 lines).

- configs/default/AGENTS.md:14-15: replace the parenthetical with one sentence: "The project sets no schedule, so an idle project sleeps; `await itx.schedules.set({ key: "heartbeat", when: { everyMs: 5 * 60_000 }, events: [{ type: "heartbeat" }] })` here wakes it every five minutes until `itx.schedules.cancel("heartbeat")`."
- apps/os/src/project/default-template.test.ts:
  - Drop the HeartbeatTemplate import (:7).
  - Collapse the `test.for` at :10-44 into one plain `test("the platform's project/worker-updated installs agents and voice and sets no schedule")` that asserts only `{ rules, rows }`.
  - Shrink `fakeProject(Template = DefaultTemplate)` to `fakeProject()`. Drop its `schedules` record, `rootOffset` and the `itx.schedules.set` stub, since only the heartbeat row used them. With the stub gone, the default calling `itx.schedules.set` makes the test throw, so "sets no schedule" stays pinned with no assertion.
  - Result: 229 → 201 lines.
- apps/os/src/project/templates.test.ts:37-49: point the preset row at `label === "Minimal"`. Assert something that only minimal's files have, such as `package.json` lacking `@iterate-com/agents`, and drop the `ourBuilds` assertion. Agent pinning is the shared `filesOf` in build.ts and stays covered by the default row. Result: 352 → 346 lines.
- package.json:10: `typecheck:configs` becomes `tsc -p configs/default && tsc -p configs/minimal`.
- configs/README.md: drop the `heartbeat/` bullet at :14-15.
- apps/agents/e2e/template.e2e.test.ts:28: drop "(configs/heartbeat sets one)".
- No change is needed in knip.ts or .depot workflows (they use globs), nor in generated config-templates.js (the build rewrites it).
- Net: about −205 LOC. Concepts go from 3 shipped templates with 2 copies of the init and email-security code to 2 templates with 1 copy plus a documented one-liner.
- Semantic change: the picker and PR quick-launch links lose Heartbeat. Old heartbeat references still seed by downloading from GitHub.

### Skeptic's verdict

(a) The semantic delta holds, and it is a product change rather than a code change.

- The Dash New-project picker loses "Heartbeat". Its options come from the build's generated config-templates.js list, whose entry is `Heartbeat`.
- The PR preview comment loses its heartbeat quick-launch row. `templateQuickLaunches` in preview-config.ts builds that list from `readdirSync(configs)`.
- Old references still work. Presets are keyed at the build's own sha, so any older `…&path:configs/heartbeat` reference already misses `templateFiles` and falls back to `downloadTemplate` from the public repo (processor.ts:557).
- Existing projects own their copy, so they are unaffected.
- No spec, e2e test or dash test selects Heartbeat. The only mentions are the two unit rows and a comment at apps/agents/e2e/template.e2e.test.ts:28.

(b) The new shape is simpler, not just different.

- Four of the six files are byte-identical to configs/default (checked with cmp).
- worker.ts differs from the default only by the 8-line `itx.schedules.set` block at :17-24.
- AGENTS.md differs only in its intro line and the init bullet.
- The duplication is forced, because a template folder is copied standalone into a project repo. Heartbeat cannot import default, so deleting it is the only way to lose the copy.
- A detail that strengthens the case: the duplicated email case is a security filter. Only mail a member sent straight from their own domain reaches an agent, and that agent has the root's full reach. The default-template.test.ts email rows run only against DefaultTemplate, so the heartbeat copy of that filter is untested and must be kept in step with the default's by hand. It has been so far: #3439 and #3442 both edited it in step.

(c) No platform guarantee is dropped. Schedules are pinned by apps/os/**workers-tests**/scheduled-appends.test.ts, the e2e scheduled-appends tests and loop-guard.test.ts, independent of any template. One possible loss: templates.test.ts's preset row asserts that a preset's agents and voice are pinned to this build. Heartbeat is the only preset with those dependencies, since configs/minimal has none. That pinning is the same `filesOf` in apps/os/scripts/build.ts for the default and every preset, and the default row ("omitting a template seeds…") already asserts `ourBuilds`. So there is no real coverage loss.

(d) The candidate undercounted, as the LOC figures show. It also missed that the fake's schedules machinery is needed only by the heartbeat row. That covers the `schedules` record, `rootOffset`, the `itx.schedules.set` stub and the `Template` parameter.

Caveat: this is the owner's call. The memory file project_config_entrypoint_fanout_no_relays_2026_09_28.md records that an agent chose "KEEP heartbeat preset" on Jonas's behalf from his earlier words, and that the heartbeat question was still awaiting Jonas. So the preset was kept on purpose, but Jonas never made the call himself.

Payoff is modest, because this is template code at the edge of the platform, not core code.

## Kit handles a failed end of the previous installer session like the app gate does (discard and continue), not with a 503 page and its own /.auth/forget route

- Sweep index: 80; risk: medium; payoff: 3/10
- LOC: About −100 net.
- device-auth.ts: 198 → about 131.
- device-auth.test.ts: 247 → about 212. The forget test goes, and the failed-end test now asserts discard, then begin. (skeptic measured: Measured by building the proposed files in the scratchpad (scratchpad/kitsim):
- apps/kit/src/device-auth.ts: 198 → 135 (−63).
- apps/kit/src/device-auth.test.ts: 247 → 215 (−32), or 211 (−36) once the fixture's unused `host` mock goes.
- packages/iterate/src/app-server.ts: ±0 (`export` dropped from `sessionCookieName`).
- Net about −95 to −99.)
- Concepts: Two policies for 'ending the previous session failed' become one, and one Kit-only route goes.

### Evidence

Merges the parallel and heavy hunts.

Kit today, in apps/kit/src/device-auth.ts:

- :52-66: a device login ends the previous session first, and on failure returns `couldNotEndPreviousSession`.
- :164-198: that 503 HTML page, with its own escapeHtml.
- :109-129: a Kit-only POST /.auth/forget that clears the cookie and rebuilds the query.

The gate, for the same situation:

- packages/iterate/src/app-server.ts:405-412 handles 'a deliberate switch' in 4 lines: `try { await session!.end(); } catch { await session!.discard(); }`.
- startAppSession (:31-41) mints a fresh id and cookie either way.
- app-server.ts:17 exports `sessionCookieName` only so Kit's forget route can use it.

History: #3060 recorded 'forgetting stays the person's call'. The gate had already made that call automatically.

### Current shape

When the old platform is down or gone, Kit refuses the device login with a page that names the host and offers a 'Forget it and start again' form. That form posts to a Kit-only route.

### Proposed shape

```ts
const previous = appSession(sessions, request);
await previous?.end().catch(async (error: unknown) => {
  console.warn("kit.previous_session_not_ended", { deviceId: device.id, error });
  await previous.discard();
});
```

Delete the forget route, `couldNotEndPreviousSession` and escapeHtml. Make `sessionCookieName` private again.

### What changes

- The device login goes straight to consent on the chosen platform and clears the stale session record, with no stop and no click.
- `/.auth/forget` answers the gate's 404.
- The old grant stays valid at the old platform until it expires or is revoked. That is exactly what clicking 'Forget' leaves today.
- The choice to go back and wait for the old platform is lost.
- This reverses a recorded #3060 decision.

### Pinned by

- apps/kit/src/device-auth.test.ts:102-124
- apps/kit/src/device-auth.test.ts:189-214

### Skeptic's amended proposal

In apps/kit/src/device-auth.ts, replace lines 52-66 with the gate's own switch shape (app-server.ts:405-412), keeping one log line:

```ts
// A deliberate POST replaces only this browser's installer session, never a flashed token. When
// signing out at its platform fails (it is down, or gone), the session is discarded here anyway.
const previous = appSession(sessions, request);
try {
  await previous?.end();
} catch (error) {
  console.warn("kit.previous_session_not_ended", { deviceId: device.id, error });
  await previous!.discard();
}
```

Then:

- Delete the `/.auth/forget` branch (:109-129), `escapeHtml` and `couldNotEndPreviousSession` (:163-198).
- Drop `sessionCookieName` from Kit's import, and drop `export` from it in packages/iterate/src/app-server.ts:17 (knip would flag it otherwise).

In device-auth.test.ts:

- Rewrite :102-124 as "a previous session that cannot be ended is discarded, and the new sign-in starts". It asserts a 303, that `discard` was called, and that discard comes before `begin` in invocation order.
- Delete the forget test (:189-214).
- Add `discard` to the fixture stub and remove the now-unused `host` mock.

Say in the PR that this reverses #3060's "forgetting stays the person's call" to match the gate's switch policy. Also say that the discard deletes the stale refresh token immediately, which the old Forget did not.

### Skeptic's verdict

The candidate holds up against the code on origin/main at b3daf4846. PR #3446 does not touch apps/kit or `sessionCookieName`.

(a) What changes when `previous.end()` throws:

1. The device login goes on to a 303 and consent. Today it returns a 503 HTML page.
2. The old session's record, including its refresh token, is deleted at once (`discard` calls `#clear`, which runs `storage.deleteAll`). Today "Forget" only clears the cookie. The orphaned BrowserSession DO keeps its tokens until its alarm fires, up to 30 days later. So the proposal is slightly better hygiene, not worse.
3. The grant stays live at the old platform. Nobody holds its token any more, so it dies when it expires. The issuer also ends a grant that goes a week unused. Clicking "Forget" today leaves the same grant.
4. A transient failure no longer stops the flow. That covers a 10-second timeout and a 5xx from a platform that is actually up. Today the person could go back and retry so the grant is revoked properly. That option, waiting for a platform that is down, is the only real loss. #3060 says the person can't tell "gone" from "down" either.
5. `/.auth/forget` falls through to the gate and the TanStack 404.

Nothing outside `device-auth.ts` and its tests references the forget route, the page or `kit.device_login_failed` on this path. The gate's own switch, `app-server.ts:405-412`, already does end-else-discard. The gate's `/.auth/logout` (:559-568) refuses on a failed end, but its intent is "sign out". Kit's device login intent is "start a new setup", which matches the switch.

(b) It really is simpler, not a lateral move:

- One policy for a failed end instead of two. There are really three states today, because "forget" is a third one: cookie gone, record orphaned.
- One Kit-only POST route, one hand-written HTML page and a private `escapeHtml` are deleted.
- The `sessionCookieName` export in `app-server.ts` goes. It exists only for the forget route, as the #3060 PR body says.

(c) No security wall, loop limit or delivery guarantee is dropped. The kept properties:

- The platform check still runs before anything ends ("a refused platform changes nothing").
- Only a same-origin POST can replace the session.
- The token never leaves Kit.
- The flashed device token is separate from the installer session and is untouched.

It does reverse a product call recorded in #3060 by a teammate: "forgetting stays the person's call". Jonas should approve that explicitly.

(d) I re-measured by building the proposed files in the scratchpad:

- `device-auth.ts`: 198 → 135 (−63).
- `device-auth.test.ts`: 247 → 215 (−32), or 211 (−36) once the fixture's now-unused `host` mock goes.
- `app-server.ts`: ±0 (only `export` is dropped).
- Net −95 to −99.

The code is peripheral (the Kit installer), so the payoff is modest.

Amendment: use the gate's exact try/catch shape rather than `.catch` on an optional-chained RPC promise, keep a log line so the recovery is observable, and delete the fixture's `host` mock.

Tests that pin the current behaviour:

- `apps/kit/src/device-auth.test.ts:102-124`: the 503 page, the "issuer.example" host and the forget form.
- `apps/kit/src/device-auth.test.ts:189-214`: the forget route.

The first test (:40-41, end before begin) is unaffected.

## Kit checks its flash layout at build time, once: ESP-IDF plus the one iterate_kit rule, not 9 rules there and a weaker re-check in the browser

- Sweep index: 81; risk: low; payoff: 4/10
- LOC: About −200 net, measured.
- firmware-release.ts: 725 → about 643.
- firmware-release.test.ts: 543 → about 489.
- prepare-manifest.ts: 103 → about 69.
- prepare-manifest.test.ts: 186 → about 156.
- The browser-only half is about −39. (skeptic measured: Measured by applying the amended change to scratch copies, formatting with oxfmt (the original files are formatter-stable), and running `git diff --no-index --numstat`:
- firmware-release.ts: 725 → 639 (+26 / −112)
- firmware-release.test.ts: 543 → 487 (+13 / −69)
- prepare-manifest.ts: 103 → 70 (+8 / −41)
- prepare-manifest.test.ts: 186 → 145 (+11 / −52)
- flash-device.ts: 165 → 164 (+1 / −2)
- releases.test.ts: about ±1 (one expected path changes)

Total: +59 / −276, net about −217, in 6 files. Prose in apps/kit/README.md:69 and firmware/README.md:95,324 needs a few words changed, with no net change.

The candidate's figure of about −200 was close. The amended version keeps the duplicate-name check and `response.ok`, and still nets about −217.)

- Concepts: Before: 3 validators and a path rewrite.
  After: ESP-IDF plus one Kit rule at build, and a shape parse in the browser.

### Evidence

Merges the parallel (browser-only) and heavy (both sides) rows.

Build time, apps/kit/scripts/firmware-release.ts:

- :232-312 `checkFlashLayout` has 9 rules.
- Supporting code: :246-251 and :474 (flashSize threading), :589-609 (parsing flash_size and chip), :577-579 (contains()).
- :323-333 refuses a chip other than esp32s3, although :445 hard-codes `-D IDF_TARGET=esp32s3`.

ESP-IDF already enforces the generic rules (checked against v5.4.2 locally; CI pins 6.1):

- gen_esp32part.py:295-301 (overlaps) and :326-335 (table larger than the flash)
- check_sizes.py:60-97 (app larger than its slot)
- app_update CMakeLists.txt:73 (otadata image)

Browser time, apps/kit/src/firmware/prepare-manifest.ts:

- :16-53 re-checks the version, the part paths and the configuration partition, and rewrites paths to absolute. flash-device.ts:59-61 passes window.location.href only because of that rewrite.
- esp-web-tools resolves relative paths itself (flash.js:80-84).
- Only the publish job creates `kit-firmware/` tags, and the Worker serves only those tags (firmware-proxy.ts:29-39).

### Current shape

The same layout is validated three times:

- by ESP-IDF
- by a 9-rule build check plus a chip check against the script's own constant
- by the browser, on a manifest CI built, followed by a path rewrite

### Proposed shape

```ts
export function configurationPartition(
  parts: readonly FlashPart[],
  partitions: readonly Partition[],
) {
  const [kit, ...more] = partitions.filter(
    (p) => p.type === 0x40 && p.subtype === 0 && p.label === "iterate_kit",
  );
  if (!kit || more.length)
    throw new Error(`Expected one iterate_kit partition, found ${more.length + (kit ? 1 : 0)}.`);
  const over = parts.find(
    (p) => p.offset < kit.offset + kit.size && kit.offset < p.offset + p.size,
  );
  if (over) throw new Error(`${over.file} overlaps the iterate_kit partition.`);
  return { offset: kit.offset, size: kit.size };
}
// browser
const response = await fetchImpl(new URL(path, window.location.href));
return { path, ...ReleaseManifest.parse(await response.json()) };
// flash-device.ts: flash(onEvent, port, input.manifest.path, install.manifest as Manifest, input.erase)
```

This can land as two PRs: build side first, then browser side.

### What changes

Build side:

- The generic faults are checked once, by ESP-IDF, instead of twice.
- One case is no longer caught at build: a non-app image (esp-sr srmodels.bin) outgrowing its own partition. Spilling into iterate_kit is still refused, and esptool-js refuses writes past the flash.
- The chip check goes.

Browser side:

- The browser trusts CI's manifest instead of re-checking it. Anyone who can replace a manifest can equally replace a .bin.
- Part URLs are unchanged for every CI-built manifest.

### Pinned by

- apps/kit/scripts/firmware-release.test.ts:226-306 and :342-353
- apps/kit/src/firmware/prepare-manifest.test.ts:32-91
- releases.test.ts:34-49

### Skeptic's amended proposal

One PR, not two.

**Build side** (apps/kit/scripts/firmware-release.ts). Replace `checkFlashLayout` (:232-312) with:

```ts
/** The iterate_kit partition, once no flash file overlaps it and no two share a name (assets are flat).
 *  ESP-IDF's build refuses the rest: overlapping partitions, a table past the flash, an app past its slot. */
export function configurationPartition(
  parts: readonly FlashPart[],
  partitions: readonly Partition[],
) {
  const files = parts.map((part) => part.file);
  const duplicate = files.find((file, index) => files.indexOf(file) !== index);
  if (duplicate) throw new Error(`Two flash files are named ${duplicate}.`);
  const [kit, ...more] = partitions.filter(
    (p) => p.type === 0x40 && p.subtype === 0 && p.label === "iterate_kit",
  );
  if (!kit || more.length > 0)
    throw new Error(
      `Expected one iterate_kit partition (type 0x40, subtype 0x00), found ${more.length + (kit ? 1 : 0)}.`,
    );
  const over = parts.find(
    (part) => part.offset < kit.offset + kit.size && kit.offset < part.offset + part.size,
  );
  if (over) throw new Error(`${over.file} overlaps the iterate_kit partition.`);
  return { offset: kit.offset, size: kit.size };
}
```

Also on the build side:

- Delete `contains` and `overlaps` (:577-583).
- Delete `firmwareManifest`'s `chip` input and the esp32s3 check (:326-333, :529).
- Shrink `readFlasherArgs` to return only the offsets and paths of `flash_files`, dropping flash_size, chip and flashSize.
- Update the header comment at :10-14.

**Browser side** (apps/kit/src/firmware/prepare-manifest.ts). Replace :16-53 with:

```ts
export async function loadFirmwareManifest(release, fetchImpl) {
  const path = firmwareManifestPath(release.deviceId, release.version);
  const response = await fetchImpl(new URL(path, window.location.href));
  if (!response.ok) throw new Error(`Firmware manifest returned HTTP ${response.status}.`);
  return { path, ...ReleaseManifest.parse(await response.json()) };
}
```

In flash-device.ts:59-60, pass `input.manifest.path` in place of `window.location.href` and drop its comment. `prepareInstall` is unchanged: the configuration image's blob URL is absolute, so esp-web-tools' `new URL(part.path, manifestURL)` returns it unchanged.

**Tests:**

- Shrink the checkFlashLayout table to "two files with one name" and "a file inside iterate_kit". Keep the "exactly one iterate_kit" test.
- Drop the chip test.
- prepare-manifest.test.ts: keep the HTTP 404 test and the "no configurationPartition" row. The contract test and releases.test.ts now expect `./<file>` paths.

**Say plainly in the PR:** a non-app flash image (esp-sr srmodels.bin) that outgrows its own partition is no longer caught by anything. ESP-IDF does not check it, esp-sr only prints a recommendation, and esp-web-tools passes `flashSize: "keep"`, so esptool-js skips its fit check. Today it is 291 KB in a 4 MiB last partition.

### Skeptic's verdict

The core claim holds, and the new shape really is simpler. But the candidate got three things wrong, so the proposal is amended below. PR #3446 touches no Kit files.

Checked against ESP-IDF v5.4.2 (the local copy; CI pins v6.1, which I could not check):

- gen_esp32part.py:295-301 refuses overlapping partitions, and :326-335 refuses a table larger than the flash. partition_table/CMakeLists.txt:32 passes `--flash-size`.
- check_sizes.py refuses an app larger than its slot, and a bootloader that runs into the partition table (wired at esptool_py/CMakeLists.txt:59,70). It only warns when some app slot still fits, but ota_0 and ota_1 are the same size in both Kit tables.
- app_update/CMakeLists.txt:13-32 always emits ota_data_initial.bin when there is an otadata partition.
- The bootloader at offset 0 and partition-table.bin come from every app build.
- `-D IDF_TARGET=esp32s3` is hard-coded at firmware-release.ts:445, so the chip check at :331-333 only checks the script's own constant.

So 7 of the 9 checkFlashLayout rules repeat what ESP-IDF already refuses. The browser's three checks are a weaker re-run of CI's (it only tests where a part starts, CI tests the whole overlap). The path rewrite exists only so flash-device.ts:59-60 can pass `window.location.href`. esp-web-tools already resolves relative part paths against the manifest path it is given (flash.js:80-84), and the blob URL for the configuration image is absolute, so it resolves unchanged.

What the candidate got wrong:

1. **"esptool-js refuses writes past the flash" is false.** esp-web-tools calls `writeFlash` with `flashSize: "keep"` (flash.js:148). esptool-js only checks that files fit when the size is not "keep" (esploader.js:1288). esp-sr does not size-check srmodels.bin either: its movemodel.py only prints a recommended partition size. So a non-app image that outgrows its partition is caught by nothing. Today that gap is harmless: srmodels.bin is 291 KB in a 4 MiB `model` partition, which is the last partition of the 16 MiB table (0xA20000-0xE20000). It would have to exceed about 6 MiB to leave the flash, and the 8 MiB table has no model partition.
2. **It silently drops the duplicate-file-name check (:252-254).** Release assets are flat, and ESP-IDF knows nothing about basenames. On a collision, `copyFileSync` would overwrite one file and the manifest would name the same file at two offsets. That is a real Kit-only rule costing 3 lines, so the amended version keeps it.
3. **Its browser sketch drops `response.ok`.** A 404 would then surface as a JSON syntax error instead of "Firmware manifest returned HTTP 404." That is visible in the page's problem alert, and prepare-manifest.test.ts:93-100 pins it. The amended version keeps it.

Also, "two PRs" goes against Jonas's one-PR rule. This is one PR.

What changes, in full:

- **Build side:**
  - These checks go: offset 0 present, partition-table.bin present, every part inside a partition, part-to-part overlap, otadata initialised, parts within the flash size, iterate_kit within the flash size, and the chip check. Of these, only "every part inside a partition" and "parts within the flash size" lose coverage, and only for srmodels.bin (see point 1). The rest remain enforced by ESP-IDF or cannot fail given the hard-coded target.
  - The `flash_size` and chip fields are no longer parsed.
  - The error text for a part overlapping iterate_kit loses its hex ranges.
- **Browser side:**
  - It no longer refuses a manifest whose version differs from its tag, whose parts point outside its directory, or whose part starts inside `configurationPartition`. Only a hand-edited GitHub release asset could produce any of these. Anyone able to edit one could equally replace a .bin, which the browser never hashes, so no security wall goes.
  - Part paths stay relative (`./x.bin`), and `FirmwareManifest` gains `path`.
  - The device page shows `manifest.version` straight from the manifest. It equals the tag for every manifest CI builds.
- **Real guarantees kept:**
  - No flash file touches iterate_kit, which is exactly one partition.
  - File names are unique.
  - The ESP-IDF layout checks.
  - The publish job's byte-for-byte check against prd Kit.
  - The proxy's path allow-list.

Both halves were added in the initial pipeline PRs (#2934 and #2948, 2026-09-24), not in response to an incident.

**Tests that change:**

- firmware-release.test.ts:226-306: the rejection table shrinks to duplicate names and a file inside iterate_kit. The "not exactly one iterate_kit" test stays.
- firmware-release.test.ts:342-353: the chip test goes.
- prepare-manifest.test.ts:32-91: the absolute-path assertion and the version, beside-the-manifest and inside-the-partition rows go. The "no configurationPartition" row stays.
- prepare-manifest.test.ts:103-140: the contract test now expects relative paths.
- releases.test.ts:39-49: the expected part path becomes `./bootloader.bin`.

**Risk:** low. The only new blind spot is a model image that outgrows its own last partition, which has plenty of headroom today.

## Kit keeps its password toggle and flash progress in useState, not in TanStack Query's cache under a random per-attempt key

- Sweep index: 82; risk: low; payoff: 3/10
- LOC: About −12 net. (skeptic measured: Measured by applying the change to scratchpad copies and running `git diff --no-index --numstat`:
- apps/kit/src/components/setup-wizard.tsx: 306 to 291 lines (+6/−21).
- apps/kit/src/routes/_auth/devices.$deviceId.tsx: 443 to 440 lines (+5/−8).
- Net: −18 lines.)
- Concepts: Before: 2 state stores, one of them keyed per attempt. After: 1, component state.

### Evidence

Merged from the parallel and heavy hunts.

Flash progress:

- apps/kit/src/components/setup-wizard.tsx:52-74 writes progress with `setQueryData(flashProgressKey(attempt))` and reads it back with `useQuery({ queryFn: skipToken })`.
- :135 creates an `attempt: crypto.randomUUID()` for each attempt, only to build that key.
- :289-291 defines flashProgressKey.

Password toggle:

- apps/kit/src/routes/_auth/devices.$deviceId.tsx:422-443 stores the show/hide boolean as a query with no fetcher.

House rules:

- docs/frontend-development.md:36 and :38 say 'No TanStack Query in the apps' and 'Plain React state'.
- Kit is the only app that depends on it.

### Current shape

Two pieces of purely local UI state go through the router's QueryClient. The flash progress is keyed by a UUID created per attempt so that each attempt starts empty.

### Proposed shape

```tsx
const [progress, setProgress] = useState<FlashProgress>();
const flashing = useMutation({
  onMutate: () => setProgress(undefined),
  mutationFn: (input: { configuration: DeviceConfiguration; erase: boolean }) =>
    flashDevice({ manifest, device, ...input, onProgress: setProgress }),
});
const [shown, setShown] = useState(false);
```

The wizard's mutations stay; they are the step machine.

### What changes

- Nothing changes visibly.
- The toggle resets when the field remounts. Neither component unmounts during use.

### Pinned by

None.

### Skeptic's amended proposal

**setup-wizard.tsx**

- Imports: import only `useMutation` from `@tanstack/react-query`, and add `import { useState } from "react";`.
- Replace `useQueryClient`, the `attempt`-keyed `flashing`, and the `useQuery(skipToken)` progress read (with its comment) at :52-74 with:

```tsx
const [progress, setProgress] = useState<FlashProgress>();
const flashing = useMutation({
  mutationFn: (input: { configuration: DeviceConfiguration; erase: boolean }) =>
    flashDevice({ manifest, device, ...input, onProgress: setProgress }),
  onMutate: () => setProgress(undefined),
});
```

- Drop `attempt: crypto.randomUUID()` (:135) and `flashProgressKey` (:289-291).
- The `preparing`, `flashing`, `logging` and `closingLogs` mutations stay; they are the step machine.

**devices.$deviceId.tsx**

- Change the react import to `import { useState, type ComponentProps } from "react";`.
- Keep the TanStack Query import; `has-openai-key` and the `invalidateQueries` call still use it.
- In `PasswordInput` (:422-443):
  - Replace the doc comment with `/** A password field with a show/hide button. */`.
  - Drop `& { id: string }`; it existed only to build the cache key.
  - Replace `queryClient`, `shownKey` and the `useQuery` with `const [shown, setShown] = useState(false);`.
  - Change the onClick to `() => setShown(!shown)`.

**What changes:** a revealed Wi-Fi password now resets to hidden after the user navigates away and back, where the query cache's 5-minute gcTime used to remember it. Nothing else a user can see changes.

**Concepts:** from 2 state stores (component state plus the query cache as a keyed UI store with a UUID per attempt) to 1.

**Risk:** low. **Pinned by:** no tests or specs.

### Skeptic's verdict

I checked this against origin/main at b3daf4846. PR #3446 touches no Kit file.

**(a) Is the semantics delta almost identical?** Yes. Progress is shown only while `flashing.isPending` (setup-wizard.tsx:188-199). The only job of the per-attempt UUID key (:135, :71-74, :289-291) is to make each attempt start at `undefined`. `onMutate: () => setProgress(undefined)` gives the same result, and it runs before `mutationFn` calls `choosePort`.

A late progress event cannot leak between attempts. `flashDevice` only emits from inside `await flash(...)` (flash-device.ts:52-57). The dialog also refuses to close or retry while a flash is pending, so only one attempt runs at a time.

The password toggle has one caller, `wifi-password` at devices.$deviceId.tsx:354. That field is always rendered, and a change of `deviceId` keeps the same route component mounted, so both shapes keep the toggle across devices. Only two behaviours change:

1. The query cache kept "shown" for gcTime (5 min) after the page unmounted. Navigating away and back within that window left the password revealed; with `useState` it comes back hidden, which is arguably better.
2. Stale cache entries from past attempts no longer linger.

No caller depends on either. No tests or specs pin any of it: Kit has no component tests, and a grep of `specs/` finds nothing.

**(b) Is it really simpler?** Yes. It removes one concept: using TanStack Query's cache as a store for local UI state, with `skipToken` queries holding no fetcher, a random UUID cache key per attempt, and a key-builder function. It also removes the two comments that explain that mechanism. The fact that it needed a comment reading "Whether it shows lives in the query cache (like the wizard's flash progress)" is the "hard to explain = smell" case. Afterwards Kit's TanStack Query use is only real server state (`has-openai-key`) and the mutations that form the wizard's step machine.

The dependency stays, and Kit still departs from docs/frontend-development.md:36. The candidate does not claim otherwise.

**(c) Does it drop a guarantee?** None exists here. This is purely client UI state.

**(d) LOC, measured.** I applied the change to copies in the scratchpad and diffed them:

- setup-wizard.tsx: 306 to 291 lines (+6/−21).
- devices.$deviceId.tsx: 443 to 440 lines (+5/−8).
- Net: −18, against the claimed "about −12".

It is small and in a peripheral app, so the payoff is low. It is still a real removal of illogical machinery, not a rename or a style nit.

## The dummy petshop stops storing a per-client token TTL that nothing can set, and stops restating 120 s for GraphQL

- Sweep index: 83; risk: low; payoff: 2/10
- LOC: About −14 lines. (skeptic measured: I applied the proposal to a scratch copy of apps/dummy-petshop/src and ran oxfmt with the repo's .oxfmtrc.json. Then I ran `git diff --no-index --stat` against the original: 8 files, +24/−39, so −15 net. By file: graphql-login.ts −7, state.ts −5, x.ts −4, google.ts −1, oauth-provider.ts −1, worker.ts 0, state.test.ts 0, cloudflare.ts +1 (the `accessToken(...)` call no longer fits in 100 columns and wraps to 5 lines). The candidate's "about −14" is right.)
- Concepts: 3 spellings of one lifetime become 1 constant.

### Evidence

- apps/dummy-petshop/src/state.ts:26-29 declares `OauthClient.accessTokenTtlSeconds`.
- Every writer sets it to DEFAULT_ACCESS_TTL_SECONDS: the seed at :240 and createClient at :276.
- The only input that could vary it, the backdoor from 24987c041, was removed by #3236 (dbc82d0f5).
- Four providers still read it back per token request: oauth-provider.ts:129, google.ts:102, cloudflare.ts:93 and x.ts:57,61.
- graphql-login.ts:25-30 adds GRAPHQL_SESSION_TTL_SECONDS = 120, whose docstring points at DEFAULT_ACCESS_TTL_SECONDS. That is an indirection constant.

### Current shape

Each client record in the state blob carries a TTL that is always 120 s, and a second constant restates the same 120 s.

### Proposed shape

- `interface OauthClient { clientSecret: string; redirectUris?: string[]; public?: boolean }`.
- The four providers mint with DEFAULT_ACCESS_TTL_SECONDS directly.
- graphql-login.ts and worker.ts:67 use the same constant.
- Tesco's 900 s and GitHub's token lifetimes stay, because those mirror the real providers.

### What changes

- Nothing changes on the wire.
- Records already in the state blob keep a field nobody reads, until the blob is rewritten.

### Pinned by

- apps/dummy-petshop/src/state.test.ts:74, a fixture literal.
- e2e rows observe expires_in, which is unchanged.

### Skeptic's amended proposal

The candidate is right as written, with three details to add.

1. **Rename the constant.** Rename `DEFAULT_ACCESS_TTL_SECONDS` to `ACCESS_TOKEN_TTL_SECONDS`. "DEFAULT" was the last trace of a per-client override that no longer exists. The rename touches the same lines, so the LOC barely changes.

2. **Keep the reason from the GraphQL docstring.** Don't drop the one real reason graphql-login.ts:25-29 gives: a session must outlive the gap between its mint and its first use, and a loaded e2e run stretches that gap. Fold it into the constant's own docstring in state.ts, for example: "Short so integration e2e can reach real expiry; long enough to outlive the gap between a token's mint and its first use under a loaded e2e run (it was 3 s for GraphQL until #3006); tests force 401s through expire-tokens." That adds about 2 lines, so the net is about −13.

3. **The concrete changes:**
   - state.ts: `interface OauthClient { clientSecret: string; redirectUris?: string[]; public?: boolean }`, the seed becomes `[DEFAULT_CLIENT_ID]: { clientSecret: DEFAULT_CLIENT_SECRET }`, and createClient drops the field.
   - oauth-provider.ts, google.ts, cloudflare.ts and x.ts pass the constant straight to `accessToken(clientId, grant, ACCESS_TOKEN_TTL_SECONDS)` and to `expires_in`. google.ts, cloudflare.ts and x.ts add it to their `./state.ts` import.
   - graphql-login.ts deletes `GRAPHQL_SESSION_TTL_SECONDS` and imports the constant.
   - worker.ts:28 drops that import, and worker.ts:67 interpolates the one constant.
   - state.test.ts:74 becomes `{ clientSecret: "s" }`.

Result:

- **LOC:** 8 files; −15 as proposed (formatted), about −13 with the docstring line.
- **Concepts:** three names for one lifetime become one constant.
- **Risk:** low.
- **Pinned by:** only the state.test.ts:74 fixture literal.

### Skeptic's verdict

The claim holds. It is a small but real case of configuration nobody varies, plus an indirection constant. It is not heavy junk.

(a) Semantics:

- Only two writers set `OauthClient.accessTokenTtlSeconds`: the seed (state.ts:240) and `createClient` (state.ts:276). Both write `DEFAULT_ACCESS_TTL_SECONDS`.
- #3236 (dbc82d0f5, 2026-09-26) removed the only input that could vary it: the backdoor's `accessTokenTtlSeconds` body field. Its one caller was a petshop self-test posting `{ accessTokenTtlSeconds: 7 }`, deleted in the same PR.
- Nothing outside apps/dummy-petshop/src references either the field or `GRAPHQL_SESSION_TTL_SECONDS`. I grepped the whole repo, including apps/os workers tests, e2e rows and scripts.
- Four providers read the field back: oauth-provider.ts:129, google.ts:102, cloudflare.ts:93 and x.ts:57/61. They would read the constant directly and still send `expires_in: 120`.
- `GRAPHQL_SESSION_TTL_SECONDS` was 3 s until #3006 (8b6566a04) deliberately set it to the pets API's 120 s. Its docstring now says it _is_ `DEFAULT_ACCESS_TTL_SECONDS`, so merging the two changes nothing.
- The only real behaviour change: a client minted before #3236 by the old backdoor with a custom TTL (for example 7 s), and still among the 500 newest in the deployed state, would now get 120 s. Nothing uses those client ids any more.
- Stored state blobs keep a dead field until they are rewritten.
- No test asserts the value. state.test.ts:74 only builds a fixture literal. authorization-server.test.ts and test-controls.test.ts do not check expires_in.

(b) The new shape is strictly simpler, not a lateral move:

- One less field in the persisted state type.
- One less exported constant, so knip has less surface.
- Nobody looks up a constant through a per-client record on every token request. That lookup implies per-client variation that no longer exists.
- Three spellings of one lifetime become one. Tesco's 900 s and GitHub's 60 s and 8 h stay, because they mirror the real providers.

(c) It drops no guarantee. This is a test fake, and nothing on the wire changes.

The payoff is low because it is a leftover from #3236 rather than convoluted machinery. It belongs in a small-cleanups bundle, not in its own PR.
