// The app's one answer to "which build am I on, and is it current?" — pure
// half. Every rule lives here (what channel am I really on, is this binary
// worth watching for updates, what does an update check MEAN), so the node
// vitest tests cover all of it without a device. The Expo bindings and the
// react-query wrappers are the other half, src/lib/build-state.ts.
//
// Replaces the reading that used to be spread across build-info.ts,
// preview-channel.ts, native-install-guard.ts and four screens, each deriving
// the same facts its own way.
import raw from "../build-info.json";

/** Stamped by scripts/write-build-info.mjs before `eas update` publishes and
 * `eas build` runs. The checked-in placeholder is all empty strings — an
 * unstamped local Metro bundle. */
export type BuildStamp = typeof raw;

/** The channel that tracks main. A binary built for anything else is a
 * preview of something, and gets watched for updates (see `watched`). */
export const MAIN_CHANNEL = "preview";

// Dev-web-only escape hatch: playwright specs (and humans poking at stamped
// behavior) can pretend the bundle was stamped by seeding localStorage
// "build-info-override" with a partial stamp. Compiled out of production
// bundles (__DEV__ is false, the branch is dead code) and inert on native
// (no localStorage).
function devOverride(): Partial<BuildStamp> {
  if (typeof __DEV__ === "undefined" || !__DEV__) return {};
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem("build-info-override") || "{}");
  } catch {
    return {};
  }
}

/** The running JS bundle's own stamp. */
export const buildStamp: BuildStamp = { ...raw, ...devOverride() };

/**
 * The result of asking the update server about this channel.
 *
 * Deliberately has no "incompatible" case. `checkForUpdateAsync` answers
 * `noUpdateAvailableOnServer` both when you are genuinely current AND when the
 * channel has newer JS your runtime can't run — the update server filters by
 * runtime version before it answers, so the phone cannot tell those apart.
 * "current" therefore means "nothing newer that THIS binary can run", and the
 * copy says so rather than promising more than we know.
 */
export type UpdateCheck =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; stamp: Partial<BuildStamp>; publishedAt: string | null }
  | { kind: "error"; message: string };

export type UpdateStatus =
  /** No OTA at all: a Metro bundle, or a dev bundle where checks throw. */
  | { kind: "unsupported"; why: "metro" | "dev" }
  /** Haven't asked yet. */
  | { kind: "unknown" }
  | { kind: "checking" }
  /** Nothing newer that this binary can run. */
  | { kind: "current" }
  /** The channel has JS this binary can run and isn't running. */
  | { kind: "behind"; branch: string; commit: string; message: string; publishedAt: string | null }
  | { kind: "error"; message: string };

/** Plain facts in, whole view model out. Gathered by build-state.ts. */
export type BuildFacts = {
  stamp: BuildStamp;
  /** Updates.isEnabled — false for a Metro bundle. */
  updatesEnabled: boolean;
  /** __DEV__ — an expo web dev bundle reports isEnabled but checks throw. */
  isDevBundle: boolean;
  isEmbeddedLaunch: boolean;
  /** Updates.channel: the channel baked into the binary at build time. */
  defaultChannel: string | null;
  /** The stored "point this binary at another channel" override, if any. */
  channelOverride: string | null;
  runtimeVersion: string | null;
  updateId: string | null;
  /** Updates.createdAt for the running update. */
  publishedAt: string | null;
  check: UpdateCheck;
  appVersion: string | null;
  nativeBuildVersion: string | null;
  installedAt: string | null;
};

export type BuildState = {
  /** The JS actually executing. */
  running: {
    branch: string;
    commit: string;
    message: string;
    builtBy: string;
    machine: string;
    publishedAt: string | null;
    source: "metro" | "embedded" | "ota";
  };
  /** The running update's id — the thing EAS support asks for. */
  updateId: string | null;
  /** The binary underneath it. */
  binary: {
    version: string | null;
    buildNumber: string | null;
    runtimeVersion: string | null;
    installedAt: string | null;
    /** The channel baked in at build time — the default OTA branch for this
     * build, and (once CI builds per PR) the branch it was built for. */
    defaultChannel: string | null;
  };
  /** Where updates actually come from: the override, else the build's own
   * channel. Null for a Metro bundle (which has neither) and on a boot where
   * the baked channel is still unknown and no override is set. */
  channel: string | null;
  update: UpdateStatus;
  /** Worth checking on every open: an overridden channel, or a binary built
   * for something other than main. A phone tracking main stays silent. */
  watched: boolean;
};

/** True when the app has been pointed away from its build's own channel. */
export function isOverridden(state: BuildState): boolean {
  return state.channel !== null && state.channel !== state.binary.defaultChannel;
}

export function describeBuildState(facts: BuildFacts): BuildState {
  const channel = facts.channelOverride || facts.defaultChannel;
  const overridden = channel !== null && channel !== facts.defaultChannel;
  // Unknown (null) counts as non-main: the boot right after an install is
  // exactly when the baked channel can't be known yet AND when a freshness
  // check matters most — the binary embeds JS from build-trigger time, and
  // the branch has usually moved since. One possibly-redundant check on a
  // main binary's first clean boot is the cost.
  const nonMainBinary = facts.defaultChannel !== MAIN_CHANNEL;
  const canOta = facts.updatesEnabled && !facts.isDevBundle;

  return {
    running: {
      branch: facts.stamp.branch,
      commit: facts.stamp.commit,
      message: facts.stamp.message,
      builtBy: facts.stamp.builtBy,
      machine: facts.stamp.machine,
      publishedAt: facts.publishedAt,
      // A dev bundle comes off Metro whatever expo-updates reports: on expo
      // web `isEnabled` is true while every check throws, and calling that
      // "OTA update" contradicts the update row right below it.
      source:
        !facts.updatesEnabled || facts.isDevBundle
          ? "metro"
          : facts.isEmbeddedLaunch
            ? "embedded"
            : "ota",
    },
    updateId: facts.updateId,
    binary: {
      version: facts.appVersion,
      buildNumber: facts.nativeBuildVersion,
      runtimeVersion: facts.runtimeVersion,
      installedAt: facts.installedAt,
      defaultChannel: facts.defaultChannel,
    },
    channel,
    update: describeUpdate(facts),
    watched: canOta && (overridden || nonMainBinary),
  };
}

function describeUpdate(facts: BuildFacts): UpdateStatus {
  if (!facts.updatesEnabled) return { kind: "unsupported", why: "metro" };
  if (facts.isDevBundle) return { kind: "unsupported", why: "dev" };
  switch (facts.check.kind) {
    case "idle":
      return { kind: "unknown" };
    case "checking":
      return { kind: "checking" };
    case "current":
      return { kind: "current" };
    case "error":
      return { kind: "error", message: facts.check.message };
    case "available":
      return {
        kind: "behind",
        // An update published before CI stamped app config carries no stamp;
        // "something newer exists" is still worth saying.
        branch: facts.check.stamp.branch || "",
        commit: facts.check.stamp.commit || "",
        message: facts.check.stamp.message || "",
        publishedAt: facts.check.publishedAt,
      };
  }
}

/** One line for the update banner and the Build info row. Empty when there is
 * nothing worth saying (current, or not asked yet). */
export function updateHeadline(status: UpdateStatus): string {
  switch (status.kind) {
    case "behind":
      return status.message
        ? `New update on this channel: "${status.message}"`
        : "A newer update is available on this channel";
    case "checking":
      return "Checking for a newer update…";
    case "error":
      return `Couldn't check for updates: ${status.message}`;
    case "current":
      return "You're on the latest update this build can run.";
    case "unsupported":
      return status.why === "metro"
        ? "OTA updates are off in this bundle — it came from a Metro dev server."
        : "OTA updates don't run in dev bundles — can't pull the channel's latest here.";
    case "unknown":
      return "";
  }
}

/**
 * The stamp CI writes into app config `extra.buildInfo`, read off an update
 * manifest we have NOT downloaded — that is what turns "an update exists" into
 * "an update with this commit message exists". Shape-checked rather than
 * trusted: the manifest is remote data.
 */
export function stampFromManifest(manifest: unknown): Partial<BuildStamp> {
  // Cast to any because this is remote data with no trustworthy static type:
  // expo's Manifest union doesn't describe `extra.expoClient.extra`, and even
  // if it did, the server could send anything. The cast only reaches into the
  // object; every field is runtime-checked below before it's used.
  const extra = (manifest as any)?.extra?.expoClient?.extra?.buildInfo;
  if (!extra || typeof extra !== "object") return {};
  const strings = ["branch", "commit", "message"] as const;
  const out: Partial<BuildStamp> = {};
  for (const key of strings) {
    if (typeof extra[key] === "string") out[key] = extra[key];
  }
  return out;
}
