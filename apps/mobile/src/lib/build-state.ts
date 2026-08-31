// The app's one answer to "which build am I on, and is it current?" — the
// Expo/react-query half. Every screen that used to gather these facts itself
// (Build info, the QR confirm screen, the root layout, the sign-in screen)
// now reads `useBuildState()` and calls `useBuildActions()`.
//
// Absorbs the old build-info.ts, preview-channel.ts and native-install-guard.ts.
// The rules live next door in build-state-core.ts, which is pure so the node
// vitest tests cover them without a device.
//
// Channel overrides use expo-updates' headers-only override, which is allowed
// without `disableAntiBrickingMeasures` because the override keys must already
// exist in the embedded request headers (EAS embeds expo-channel-name). The
// override persists natively (UserDefaults) across restarts; expo-updates
// exposes no getter, so we mirror the active value in AsyncStorage ourselves.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Platform } from "react-native";
import { MobileChannelStatus } from "@iterate-com/shared/mobile-channel-status";
import { queryClient } from "./query.ts";
import {
  type BuildState,
  buildStamp,
  type ChannelStatusCheck,
  describeBuildState,
  type UpdateCheck,
  stampFromManifest,
} from "./build-state-core.ts";
import { PRODUCTION_PRESET } from "./servers.ts";

export {
  type BuildState,
  type BuildStamp,
  buildStamp,
  isOverridden,
  MAIN_CHANNEL,
  type UpdateStatus,
  updateHeadline,
} from "./build-state-core.ts";

const OVERRIDE_KEY = "preview-channel-override";
const AUTO_CONTINUE_KEY = "preview-channel-auto-continue";
const LAST_SEEN_INSTALL_KEY = "native-install.last-seen";

const overrideKey = ["build-state", "channel-override"];
const checkKey = ["build-state", "update-check"];
const installedAtKey = ["build-state", "installed-at"];
const bakedChannelKey = ["build-state", "baked-channel"];

const binaryId = () =>
  `${Application.nativeApplicationVersion}/${Application.nativeBuildVersion}/${Updates.runtimeVersion}`;

// Updates.channel is NOT the baked channel: natively it reads
// requestHeaders["expo-channel-name"] off the config as merged AT LAUNCH, and
// a persisted override wins that merge (AppController.toModuleConstantsMap /
// UpdatesConfigOverride.load in expo-updates). Restart with an override set
// and Updates.channel reports the override — which made Build info claim a
// PR binary's "default" was whatever it was overridden to, hiding every
// route back. The plist's original headers never cross the bridge, so the
// baked channel has to be learned: on a boot that LAUNCHED override-free,
// Updates.channel is trustworthy — cache it per binary and use the cache on
// polluted boots. Until one clean boot has happened it is simply unknown.
//
// Captured at import time, before anything in this session can rewrite the
// stored override (the install guard clears it; screen taps change it).
const overrideAtLaunch: Promise<string | null> = AsyncStorage.getItem(OVERRIDE_KEY);

async function resolveBakedChannel(): Promise<string | null> {
  if (!Updates.isEnabled || Updates.channel === null) return null;
  const key = `baked-channel.${binaryId()}`;
  const cached = await AsyncStorage.getItem(key);
  if (cached !== null) return cached;
  if ((await overrideAtLaunch) !== null) return null;
  await AsyncStorage.setItem(key, Updates.channel);
  return Updates.channel;
}

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

export async function getChannelOverride(): Promise<string | null> {
  return AsyncStorage.getItem(OVERRIDE_KEY);
}

async function setChannelOverride(channel: string | null) {
  Updates.setUpdateRequestHeadersOverride(channel ? { "expo-channel-name": channel } : null);
  // Any check already in flight is now asking about the previous channel —
  // callers from here on must not join it (see sharedCheckForUpdateAsync).
  channelGeneration++;
  if (channel) {
    await AsyncStorage.setItem(OVERRIDE_KEY, channel);
  } else {
    await AsyncStorage.removeItem(OVERRIDE_KEY);
  }
}

// Deliberately NOT invalidated inside setChannelOverride: the switch
// mutation writes the override and only THEN checks/fetches/reloads, and a
// mid-flight cache refresh makes the QR screen treat the switch as already
// done — arming its freshness pull as a concurrent second check whose throw
// would revert a perfectly good switch through the error path. Instead the
// two effectful boundaries invalidate when they settle: the switch mutation
// (below) and the install guard's clear.
const invalidateChannelOverride = () => queryClient.invalidateQueries({ queryKey: overrideKey });

// One-shot marker: the user tapped "Switch to <channel>", which already says
// "run this PR's JS against its backend as its identity" — the confirm screen
// re-opened by the switch-reload applies the bundle's recommended setup
// without a second Continue tap. Persisted (not JS state) because the reload
// wipes the process; consumed by the ACTION, not the read, so an intervening
// freshness reload doesn't drop the intent. Fresh scans of a channel the app
// is already on never set it — those keep the reassurance screen.
export const setAutoContinueChannel = (channel: string) =>
  AsyncStorage.setItem(AUTO_CONTINUE_KEY, channel);
export const getAutoContinueChannel = () => AsyncStorage.getItem(AUTO_CONTINUE_KEY);
export const clearAutoContinueChannel = () => AsyncStorage.removeItem(AUTO_CONTINUE_KEY);

/**
 * First boot of a NEW binary: clear any channel override left over from
 * before it was installed, and say that a new binary was observed at all —
 * the layout presents Build info off that, so an install is followed by the
 * screen naming the channel and commit you just landed on.
 *
 * Installing a build means wanting THAT build, not whatever an old override
 * OTA-pulls over it. The binary identity is version/build-number/runtime —
 * an EAS install changes at least one of them. Deliberately inert when the
 * stored identity is missing (first run after this shipped, or a truly fresh
 * install — a brand-new user's first open must not detour through Build
 * info): only an observed CHANGE of binary proves anything.
 *
 * With CI building per PR — the binary's own channel IS the PR's — the
 * override-clear is purely protective: it lands you on the channel you
 * installed for, rather than dropping you back onto main.
 */
export async function resetChannelOverrideForNewInstall(): Promise<{
  binaryChanged: boolean;
  clearedOverride: string | null;
}> {
  const nothing = { binaryChanged: false, clearedOverride: null };
  // Web has no installs; Metro dev bundles have no OTA for an override to hijack.
  if (Platform.OS === "web" || !Updates.isEnabled) return nothing;
  const id = binaryId();
  const seen = await AsyncStorage.getItem(LAST_SEEN_INSTALL_KEY);
  if (seen === id) return nothing;
  await AsyncStorage.setItem(LAST_SEEN_INSTALL_KEY, id);
  if (seen === null) return nothing;
  const override = await getChannelOverride();
  if (override) {
    await setChannelOverride(null);
    // The banner's read races this guard and may have landed with the old
    // value; the guard has no mutation wrapper, so it refreshes here.
    await invalidateChannelOverride();
  }
  return { binaryChanged: true, clearedOverride: override };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Dev bundles (Metro native OR expo web dev, where isEnabled is true but
 * checkForUpdateAsync throws "cannot check for updates in development mode")
 * can't OTA. */
const canOta = () => Updates.isEnabled && !__DEV__;

// expo-updates' state machine refuses to re-enter "checking", so a second
// in-flight checkForUpdateAsync REJECTS — and two callers genuinely overlap
// here: after a switch settles, the QR screen's freshness pull and the
// watched-build check arm in the same render. Everyone shares one native
// call instead — but only callers asking about the SAME channel: a check is
// stamped with the channel generation it started under (setChannelOverride
// bumps it), because a just-switched caller joining a pre-switch check would
// treat another channel's verdict as its own — and for Switch-to-main that
// verdict feeds the revert decision. A mismatched caller queues behind the
// stale call instead of overlapping it, so the no-second-check rule holds.
let channelGeneration = 0;
let checkInFlight: {
  gen: number;
  promise: ReturnType<typeof Updates.checkForUpdateAsync>;
} | null = null;
let lastCheckSettled: Promise<unknown> = Promise.resolve();
function sharedCheckForUpdateAsync() {
  if (checkInFlight && checkInFlight.gen === channelGeneration) {
    return checkInFlight.promise;
  }
  const promise = lastCheckSettled.then(() => Updates.checkForUpdateAsync());
  const entry = { gen: channelGeneration, promise };
  lastCheckSettled = promise.then(
    () => {},
    () => {},
  );
  void promise.finally(() => {
    if (checkInFlight === entry) checkInFlight = null;
  });
  checkInFlight = entry;
  return promise;
}

/**
 * The CI-pushed "expected native build" snapshot for a channel — the one
 * question checkForUpdateAsync can't answer (the update server filters by
 * runtime, so "no update" and "newer JS you can't run" look identical).
 * Always read from prd: CI writes there and the snapshot is platform
 * metadata, same as the QR links themselves.
 */
/**
 * Where every in-app "Download" button goes: the channel-stable install
 * interstitial on prd OS, NOT the raw expo.dev build page. Installing a new
 * binary clears any channel override on first boot (the new-install guard),
 * so a direct install would drop the phone back on main — the interstitial's
 * "Open in app" tap after the install re-points it, in the right order.
 */
export const installPageUrl = (channel: string) =>
  `${PRODUCTION_PRESET.baseUrl}/m/install/${channel}`;

async function fetchChannelStatus(channel: string): Promise<ChannelStatusCheck> {
  try {
    const response = await fetch(`${PRODUCTION_PRESET.baseUrl}/m/channel-status/${channel}`);
    if (!response.ok) return { kind: "unavailable" };
    const status = MobileChannelStatus.parse(await response.json());
    return {
      kind: "loaded",
      runtimeVersion: status.runtimeVersion,
      installUrl: status.installUrl,
      buildFinished: status.buildFinished,
      commit: status.commit,
      message: status.message,
    };
  } catch {
    // Offline, DNS, bad payload: say nothing rather than something wrong.
    return { kind: "unavailable" };
  }
}

async function checkForUpdate(): Promise<UpdateCheck> {
  const result = await sharedCheckForUpdateAsync();
  if (!result.isAvailable) return { kind: "current" };
  return {
    kind: "available",
    stamp: stampFromManifest(result.manifest),
    // Cast because expo types the manifest as a union that includes the
    // embedded-manifest shape, which has no createdAt — but an AVAILABLE
    // check result always came from the update server, whose manifests carry
    // it as an ISO string. Absence just reads as "unknown publish time".
    publishedAt: (result.manifest as { createdAt?: string }).createdAt || null,
  };
}

/**
 * Everything about the running build in one object. The update check is only
 * armed for a watched build (an overridden channel, or a binary built for
 * something other than main) — a phone tracking main stays silent, as before.
 *
 * The check refetches on focus, which query.ts wires to AppState: that is the
 * "check every time the app is opened" behaviour, without an AppState listener
 * of our own.
 */
/** BuildState plus the binding's own loading fact: `ready` is false until
 * the stored channel override has been read, during which `channel` is only
 * a guess (it falls back to the binary's default). Anything that ACTS on the
 * channel — the QR confirm screen above all — must wait for it; display-only
 * consumers can render the guess. */
export type LiveBuildState = BuildState & { ready: boolean };

export function useBuildState(): LiveBuildState {
  const override = useQuery({ queryKey: overrideKey, queryFn: getChannelOverride });
  const baked = useQuery({
    queryKey: bakedChannelKey,
    queryFn: resolveBakedChannel,
    staleTime: Infinity,
  });
  const installedAt = useQuery({
    queryKey: installedAtKey,
    // Unavailable on web; the row shows "—" there.
    queryFn: () => Application.getInstallationTimeAsync().catch(() => null),
    staleTime: Infinity,
  });

  // The CI snapshot for the channel the app is pointed at. Deliberately NOT
  // gated on `watched`: a main phone stranded on an old runtime after a
  // native-change merge is exactly who needs to hear "you need a different
  // native build" — checkForUpdateAsync will keep telling it "current"
  // forever. Refetches on foreground like the check (staleTime 0 + focus).
  const channel = override.data || baked.data || null;
  const channelStatus = useQuery({
    queryKey: ["build-state", "channel-status", channel],
    queryFn: () => fetchChannelStatus(channel!),
    enabled:
      override.isSuccess &&
      baked.isSuccess &&
      channel !== null &&
      canOta() &&
      Updates.runtimeVersion !== null,
    staleTime: 0,
    retry: false,
  });

  const withoutCheck = (check: UpdateCheck) =>
    describeBuildState({
      stamp: buildStamp,
      updatesEnabled: Updates.isEnabled,
      isDevBundle: typeof __DEV__ !== "undefined" && __DEV__,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      defaultChannel: baked.data || null,
      channelOverride: override.data || null,
      runtimeVersion: Updates.runtimeVersion,
      updateId: Updates.updateId,
      publishedAt: Updates.createdAt?.toISOString() || null,
      check,
      channelStatus: channelStatus.data || { kind: "idle" },
      appVersion: Constants.expoConfig?.version || null,
      nativeBuildVersion: Application.nativeBuildVersion,
      installedAt: installedAt.data?.toISOString() || null,
    });

  // Two passes: `watched` is derived from the override AND the baked
  // channel, so the check only arms once BOTH reads have landed. While the
  // baked read is in flight a main phone would otherwise look non-main
  // (null defaultChannel) for a moment and fire a check it should never run.
  // A RESOLVED-null baked channel still counts as watched — that's the
  // just-installed boot, where checking matters most.
  const armed = override.isSuccess && baked.isSuccess && withoutCheck({ kind: "idle" }).watched;
  const check = useQuery({
    queryKey: checkKey,
    queryFn: checkForUpdate,
    enabled: armed && canOta(),
    // Zero so returning to the app (focusManager ← AppState) re-asks.
    staleTime: 0,
    retry: false,
  });

  // No `armed` guard here: an unwatched build's check data can still arrive
  // via checkNow's imperative fetch (the disabled observer stays subscribed
  // to the cache), and hiding it would make the manual button look dead.
  // Data wins over "checking": the staleTime-0 refetch runs on every
  // foreground, and mapping it to "checking" would unmount the banner each
  // time the app opens — the previous verdict stands until replaced.
  return {
    ...withoutCheck(
      check.data
        ? check.data
        : check.isError
          ? { kind: "error", message: String(check.error) }
          : check.isFetching
            ? { kind: "checking" }
            : { kind: "idle" },
    ),
    ready: override.isSuccess,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Pull the newest update for whatever channel the app is pointed at.
 * `checkForUpdateAsync` compares the channel's latest against the RUNNING
 * update, so calling this again right after the reload finds nothing and
 * terminates. */
export async function fetchLatestUpdateAndReload() {
  const result = await sharedCheckForUpdateAsync();
  if (!result.isAvailable) return "up-to-date" as const;
  await Updates.fetchUpdateAsync();
  await Updates.reloadAsync();
  return "reloading" as const;
}

export type SwitchChannelInput = {
  /** null = back to the build's own channel. */
  channel: string | null;
  /** Undo the switch when the target has nothing this binary can run. The QR
   * flow keeps a sticky override (CI is about to publish for this runtime);
   * Build info's explicit switches revert — a persisted override with
   * nothing runnable behind it makes the next RESTART fall back to the
   * embedded bundle, silently running older JS than before the switch. */
  revertOnNoUpdate: boolean;
};

export type BuildActions = {
  /** Point the app at a channel, then pull whatever it has. Only "reloading"
   * actually restarts the app. */
  switchChannel: (input: SwitchChannelInput) => Promise<"reloading" | "no-update">;
  switchChannelPending: boolean;
  /** The last switch's outcome, for feedback ("no-update" deserves words —
   * a reload speaks for itself). */
  switchChannelResult: "reloading" | "no-update" | undefined;
  /** What the last switch was asked to do — lets the view word the outcome
   * ("main can't run here" vs "already on the freshest"). */
  switchChannelInput: SwitchChannelInput | undefined;
  /** A failed switch must be SHOWN: these buttons fire-and-forget, so a
   * swallowed rejection is indistinguishable from "nothing happened" —
   * which is exactly what it looked like in the field. */
  switchChannelError: string | null;
  /** Ask the server again now, without waiting for a foreground. */
  checkNow: () => Promise<unknown>;
  /** Fetch the newer update and restart into it. */
  updateNow: () => Promise<"reloading" | "up-to-date">;
  updateNowPending: boolean;
  updateNowError: string | null;
};

export function useBuildActions(): BuildActions {
  const queryClient = useQueryClient();
  const switchChannel = useMutation({
    mutationFn: async ({ channel, revertOnNoUpdate }: SwitchChannelInput) => {
      const previous = await getChannelOverride();
      await setChannelOverride(channel);
      let result;
      try {
        result = await fetchLatestUpdateAndReload();
      } catch (error) {
        // A thrown check/fetch (offline, mid-flight conflict) must not leave
        // the new override dangling — that half-switched state is exactly the
        // stranded-on-restart trap, arrived at via the error path.
        await setChannelOverride(previous);
        throw error;
      }
      if (result === "up-to-date" && revertOnNoUpdate) {
        await setChannelOverride(previous);
        return { outcome: "no-update" as const, effective: previous };
      }
      return {
        outcome: result === "up-to-date" ? ("no-update" as const) : result,
        effective: channel,
      };
    },
    // Settled, not success: the error path REVERTED the override, and the
    // cache must reflect that too.
    onSettled: (data, error) => {
      // Write the landed value synchronously first — the settle paints the
      // outcome card in the same tick, and an invalidate-only refresh would
      // let it name the PREVIOUS channel until the refetch lands. Then
      // reconcile with storage anyway (the error path restored a value this
      // scope doesn't hold).
      if (data) queryClient.setQueryData(overrideKey, data.effective);
      void invalidateChannelOverride();
      // The cached check verdict described the OLD channel; drop it rather
      // than let Build info report the wrong channel's freshness. (Remove,
      // not invalidate: on an unwatched build nothing would refetch, and
      // stale-but-displayed is exactly the bug.) Not on error — the override
      // was restored, so the old verdict still describes the live channel.
      if (!error) queryClient.removeQueries({ queryKey: checkKey });
    },
  });
  const updateNow = useMutation({
    mutationFn: fetchLatestUpdateAndReload,
    onSuccess: (result) => {
      // "up-to-date" IS a check verdict — record it so the status row says
      // so instead of leaving the tap visibly answerless.
      if (result === "up-to-date") queryClient.setQueryData(checkKey, { kind: "current" });
    },
  });
  return {
    // mutate, not mutateAsync: callers fire-and-forget, and an unhandled
    // rejection from mutateAsync is invisible on a phone. The error state
    // below is the visible channel for failures.
    switchChannel: (input: SwitchChannelInput) =>
      switchChannel.mutateAsync(input).then((landed) => landed.outcome),
    switchChannelPending: switchChannel.isPending,
    switchChannelResult: switchChannel.data?.outcome,
    switchChannelInput: switchChannel.variables,
    switchChannelError: switchChannel.error ? String(switchChannel.error) : null,
    // fetchQuery, not refetchQueries: refetch skips DISABLED queries, and the
    // check query is disabled on every unwatched build (a main phone — the
    // common case), which made this button a silent no-op there. An
    // imperative fetch populates the same cache and the observer re-renders.
    checkNow: () =>
      queryClient.fetchQuery({ queryKey: checkKey, queryFn: checkForUpdate, staleTime: 0 }),
    updateNow: updateNow.mutateAsync,
    updateNowPending: updateNow.isPending,
    updateNowError: updateNow.error ? String(updateNow.error) : null,
  };
}
