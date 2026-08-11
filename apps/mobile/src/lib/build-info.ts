import raw from "../build-info.json";

// Stamped by scripts/write-build-info.mjs before `eas update` publishes and
// `eas build` runs. The checked-in placeholder is all empty strings — an
// unstamped local Metro bundle.
//
// Dev-web-only escape hatch: playwright specs (and humans poking at stamped
// behavior, e.g. the expected-backend flows) can pretend the bundle was
// stamped by seeding localStorage "build-info-override" with a partial
// build-info object. Compiled out of production bundles (__DEV__ is false,
// the branch is dead code) and inert on native (no localStorage).
function devOverride(): Partial<typeof raw> {
  if (typeof __DEV__ === "undefined" || !__DEV__) return {};
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem("build-info-override") || "{}");
  } catch {
    return {};
  }
}

export const buildInfo = { ...raw, ...devOverride() };
