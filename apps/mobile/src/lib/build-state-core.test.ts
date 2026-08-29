import { expect, test } from "vitest";
import {
  type BuildFacts,
  describeBuildState,
  isOverridden,
  stampFromManifest,
  updateHeadline,
} from "./build-state-core.ts";

test("a preview binary tracking main is not watched", () => {
  const state = describeBuildState(facts({ defaultChannel: "preview" }));
  expect(state).toMatchObject({
    channel: "preview",
    watched: false,
    binary: { defaultChannel: "preview" },
    running: { source: "ota" },
  });
  expect(isOverridden(state)).toBe(false);
});

test("an override points the channel elsewhere, and earns a watch", () => {
  const state = describeBuildState(
    facts({ defaultChannel: "preview", channelOverride: "mobile-build-state" }),
  );
  expect(state).toMatchObject({ channel: "mobile-build-state", watched: true });
  expect(isOverridden(state)).toBe(true);
});

test("a binary built for a PR is watched with no override at all", () => {
  // What per-PR builds produce: the PR's channel baked in, nothing overridden.
  const state = describeBuildState(facts({ defaultChannel: "mobile-build-state" }));
  expect(state).toMatchObject({ channel: "mobile-build-state", watched: true });
  expect(isOverridden(state)).toBe(false);
});

test("an unknown baked channel is watched, and claims no default", () => {
  // The boot right after an install: the override was set at launch (so
  // Updates.channel is polluted and the baked channel can't be learned yet)
  // and the guard has just cleared it. Freshness matters most exactly here —
  // the embedded JS is from build-trigger time.
  const state = describeBuildState(facts({ defaultChannel: null, channelOverride: null }));
  expect(state).toMatchObject({
    channel: null,
    watched: true,
    binary: { defaultChannel: null },
  });
  expect(isOverridden(state)).toBe(false);

  // With an override on top of an unknown default, the way back must show:
  // overridden is true, so Build info renders its reset control.
  const overriddenState = describeBuildState(
    facts({ defaultChannel: null, channelOverride: "preview" }),
  );
  expect(overriddenState).toMatchObject({ channel: "preview", watched: true });
  expect(isOverridden(overriddenState)).toBe(true);
});

test("a Metro bundle has no channel, no watch, and says why", () => {
  const state = describeBuildState(
    facts({ updatesEnabled: false, defaultChannel: null, isEmbeddedLaunch: false }),
  );
  expect(state).toMatchObject({
    channel: null,
    watched: false,
    running: { source: "metro" },
    update: { kind: "unsupported", why: "metro" },
  });
  expect(updateHeadline(state.update)).toContain("Metro dev server");
});

test("a dev bundle reports updates enabled but still can't check", () => {
  const state = describeBuildState(
    facts({ isDevBundle: true, defaultChannel: "spec-chan", channelOverride: "spec-chan" }),
  );
  expect(state).toMatchObject({
    watched: false,
    update: { kind: "unsupported", why: "dev" },
    // Not "ota": expo web sets isEnabled while every check throws, and the
    // Build info source row must not contradict the update row under it.
    running: { source: "metro" },
  });
});

test("an available update carries the commit message off its manifest", () => {
  const state = describeBuildState(
    facts({
      defaultChannel: "mobile-build-state",
      check: {
        kind: "available",
        stamp: { branch: "mobile-build-state", commit: "abc1234", message: "fix the drawer glyph" },
        publishedAt: "2026-08-28T14:22:00.000Z",
      },
    }),
  );
  expect(state.update).toEqual({
    kind: "behind",
    branch: "mobile-build-state",
    commit: "abc1234",
    message: "fix the drawer glyph",
    publishedAt: "2026-08-28T14:22:00.000Z",
  });
  expect(updateHeadline(state.update)).toBe('New update on this channel: "fix the drawer glyph"');
});

test("an update published before the stamp existed still reads as behind", () => {
  const state = describeBuildState(
    facts({ check: { kind: "available", stamp: {}, publishedAt: null } }),
  );
  expect(state.update).toMatchObject({ kind: "behind", message: "" });
  expect(updateHeadline(state.update)).toBe("A newer update is available on this channel");
});

test("'current' promises only what the server can actually tell us", () => {
  // The update server filters by runtime BEFORE answering, so a phone whose
  // binary is too old is indistinguishable from one that is genuinely current.
  const state = describeBuildState(facts({ check: { kind: "current" } }));
  expect(updateHeadline(state.update)).toBe("You're on the latest update this build can run.");
});

test("a failed check is surfaced, not swallowed", () => {
  const state = describeBuildState(facts({ check: { kind: "error", message: "offline" } }));
  expect(state.update).toEqual({ kind: "error", message: "offline" });
  expect(updateHeadline(state.update)).toBe("Couldn't check for updates: offline");
});

test("the running bundle reads as embedded until an update replaces it", () => {
  expect(describeBuildState(facts({ isEmbeddedLaunch: true })).running.source).toBe("embedded");
});

test("stampFromManifest digs the stamp out, and ignores junk", () => {
  const manifest = {
    extra: {
      expoClient: {
        extra: { buildInfo: { branch: "main", commit: "deadbee", message: "hi", builtBy: 42 } },
      },
    },
  };
  expect(stampFromManifest(manifest)).toEqual({
    branch: "main",
    commit: "deadbee",
    message: "hi",
  });
  expect(stampFromManifest({})).toEqual({});
  expect(stampFromManifest(null)).toEqual({});
  expect(stampFromManifest({ extra: { expoClient: { extra: { buildInfo: "nope" } } } })).toEqual(
    {},
  );
});

function facts(overrides: Partial<BuildFacts> = {}): BuildFacts {
  return {
    stamp: {
      commit: "3f0e48f",
      message: "Playwright sweep: adopt createAgent",
      branch: "mobile-build-state",
      builtBy: "ci",
      machine: "ci",
      builtAt: "2026-08-28T12:00:00.000Z",
      expectedBackendEnv: "",
      testLoginEmail: "",
    },
    updatesEnabled: true,
    isDevBundle: false,
    isEmbeddedLaunch: false,
    defaultChannel: "preview",
    channelOverride: null,
    runtimeVersion: "fingerprint-abc",
    updateId: "11111111-1111-1111-1111-111111111111",
    publishedAt: "2026-08-28T12:05:00.000Z",
    check: { kind: "idle" },
    appVersion: "0.1.0",
    nativeBuildVersion: "12",
    installedAt: "2026-08-27T09:00:00.000Z",
    ...overrides,
  };
}
