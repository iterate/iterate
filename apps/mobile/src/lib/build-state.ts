// The app's one answer to "which build am I on, and is it current?" — the
// Expo/react-query half. Every screen that used to gather these facts itself
// (Build info, the QR confirm screen, the root layout, the sign-in screen)
// now reads `useBuildState()` and calls `useBuildActions()`.
//
// Absorbs the old build-info.ts, preview-channel.ts and native-install-guard.ts.
// The rules live next door in build-state-core.ts, which is pure so the node
// vitest lane covers them without a device.
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
import {
  type BuildState,
  buildStamp,
  describeBuildState,
  type UpdateCheck,
  stampFromManifest,
} from "./build-state-core.ts";

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

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

export async function getChannelOverride(): Promise<string | null> {
  return AsyncStorage.getItem(OVERRIDE_KEY);
}

async function setChannelOverride(channel: string | null) {
  Updates.setUpdateRequestHeadersOverride(channel ? { "expo-channel-name": channel } : null);
  if (channel) {
    await AsyncStorage.setItem(OVERRIDE_KEY, channel);
  } else {
    await AsyncStorage.removeItem(OVERRIDE_KEY);
  }
}

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
 * Clears a channel override left over from before this binary was installed;
 * returns the cleared channel (to show the user), or null when nothing
 * changed. Installing a build means wanting THAT build, not whatever an old
 * override OTA-pulls over it. The binary identity is version/build-number/
 * runtime — an EAS install changes at least one of them. Deliberately inert
 * when the stored identity is missing (first run after this shipped, or a
 * truly fresh install where there's no override anyway): only an observed
 * CHANGE of binary proves the override predates the install.
 *
 * With CI building per PR — the binary's own channel IS the PR's — this is
 * purely protective: clearing the override now lands you on the channel you
 * installed for, rather than dropping you back onto main.
 */
export async function resetChannelOverrideForNewInstall(): Promise<string | null> {
  // Web has no installs; Metro dev bundles have no OTA for an override to hijack.
  if (Platform.OS === "web" || !Updates.isEnabled) return null;
  const id = `${Application.nativeApplicationVersion}/${Application.nativeBuildVersion}/${Updates.runtimeVersion}`;
  const seen = await AsyncStorage.getItem(LAST_SEEN_INSTALL_KEY);
  if (seen === id) return null;
  await AsyncStorage.setItem(LAST_SEEN_INSTALL_KEY, id);
  if (seen === null) return null;
  const override = await getChannelOverride();
  if (!override) return null;
  await setChannelOverride(null);
  return override;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Dev bundles (Metro native OR expo web dev, where isEnabled is true but
 * checkForUpdateAsync throws "cannot check for updates in development mode")
 * can't OTA. */
const canOta = () => Updates.isEnabled && !__DEV__;

async function checkForUpdate(): Promise<UpdateCheck> {
  const result = await Updates.checkForUpdateAsync();
  if (!result.isAvailable) return { kind: "current" };
  return {
    kind: "available",
    stamp: stampFromManifest(result.manifest),
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
export function useBuildState(): BuildState {
  const override = useQuery({ queryKey: overrideKey, queryFn: getChannelOverride });
  const installedAt = useQuery({
    queryKey: installedAtKey,
    // Unavailable on web; the row shows "—" there.
    queryFn: () => Application.getInstallationTimeAsync().catch(() => null),
    staleTime: Infinity,
  });

  const withoutCheck = (check: UpdateCheck) =>
    describeBuildState({
      stamp: buildStamp,
      updatesEnabled: Updates.isEnabled,
      isDevBundle: typeof __DEV__ !== "undefined" && __DEV__,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      defaultChannel: Updates.channel,
      channelOverride: override.data || null,
      runtimeVersion: Updates.runtimeVersion,
      updateId: Updates.updateId,
      publishedAt: Updates.createdAt?.toISOString() || null,
      check,
      appVersion: Constants.expoConfig?.version || null,
      nativeBuildVersion: Application.nativeBuildVersion,
      installedAt: installedAt.data?.toISOString() || null,
    });

  // Two passes: `watched` is itself derived from the override, so the check
  // can only be armed once that read has landed.
  const armed = override.isSuccess && withoutCheck({ kind: "idle" }).watched;
  const check = useQuery({
    queryKey: checkKey,
    queryFn: checkForUpdate,
    enabled: armed && canOta(),
    // Zero so returning to the app (focusManager ← AppState) re-asks.
    staleTime: 0,
    retry: false,
  });

  return withoutCheck(
    !armed
      ? { kind: "idle" }
      : check.isFetching
        ? { kind: "checking" }
        : check.isError
          ? { kind: "error", message: String(check.error) }
          : check.data || { kind: "idle" },
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Pull the newest update for whatever channel the app is pointed at.
 * `checkForUpdateAsync` compares the channel's latest against the RUNNING
 * update, so calling this again right after the reload finds nothing and
 * terminates. */
export async function fetchLatestUpdateAndReload() {
  const result = await Updates.checkForUpdateAsync();
  if (!result.isAvailable) return "up-to-date" as const;
  await Updates.fetchUpdateAsync();
  await Updates.reloadAsync();
  return "reloading" as const;
}

export type BuildActions = {
  /** Point the app at a channel (null = back to the build's own), then pull
   * whatever it has. Only "reloading" actually restarts the app. */
  switchChannel: (channel: string | null) => Promise<"reloading" | "no-update">;
  switchChannelPending: boolean;
  /** Ask the server again now, without waiting for a foreground. */
  checkNow: () => Promise<unknown>;
  /** Fetch the newer update and restart into it. */
  updateNow: () => Promise<"reloading" | "up-to-date">;
  updateNowPending: boolean;
};

export function useBuildActions(): BuildActions {
  const queryClient = useQueryClient();
  const switchChannel = useMutation({
    mutationFn: async (channel: string | null) => {
      await setChannelOverride(channel);
      const result = await fetchLatestUpdateAndReload();
      return result === "up-to-date" ? ("no-update" as const) : result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: overrideKey }),
  });
  const updateNow = useMutation({ mutationFn: fetchLatestUpdateAndReload });
  return {
    switchChannel: switchChannel.mutateAsync,
    switchChannelPending: switchChannel.isPending,
    checkNow: () => queryClient.refetchQueries({ queryKey: checkKey }),
    updateNow: updateNow.mutateAsync,
    updateNowPending: updateNow.isPending,
  };
}
