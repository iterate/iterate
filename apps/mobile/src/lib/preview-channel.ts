// Per-PR preview channels: the installed binary defaults to the channel baked
// in at build time (`preview` = latest main), and this override points it at a
// PR's channel instead. Uses the headers-only override, which expo-updates
// allows without `disableAntiBrickingMeasures` because the override keys must
// already exist in the embedded request headers (EAS embeds expo-channel-name).
// The override persists natively (UserDefaults) across restarts; expo-updates
// exposes no getter, so we mirror the active value in AsyncStorage ourselves.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Updates from "expo-updates";

const STORAGE_KEY = "preview-channel-override";

export async function setPreviewChannelOverride(channel: string | null) {
  Updates.setUpdateRequestHeadersOverride(channel ? { "expo-channel-name": channel } : null);
  if (channel) {
    await AsyncStorage.setItem(STORAGE_KEY, channel);
  } else {
    await AsyncStorage.removeItem(STORAGE_KEY);
  }
}

export async function getPreviewChannelOverride() {
  return AsyncStorage.getItem(STORAGE_KEY);
}

// One-shot marker: the user tapped "Switch to <channel>", which already says
// "run this PR's JS against its backend as its identity" — the confirm screen
// re-opened by the switch-reload applies the bundle's recommended setup
// without a second Continue tap. Persisted (not JS state) because the reload
// wipes the process; consumed by the ACTION, not the read, so an intervening
// freshness reload doesn't drop the intent. Fresh scans of a channel the app
// is already on never set it — those keep the reassurance screen.
const AUTO_CONTINUE_KEY = "preview-channel-auto-continue";

export async function setAutoContinueChannel(channel: string) {
  await AsyncStorage.setItem(AUTO_CONTINUE_KEY, channel);
}

export async function getAutoContinueChannel() {
  return AsyncStorage.getItem(AUTO_CONTINUE_KEY);
}

export async function clearAutoContinueChannel() {
  await AsyncStorage.removeItem(AUTO_CONTINUE_KEY);
}

/** Switch channel, then pull whatever it has. Returns what happened so the
 * caller can show it; only "reloading" actually restarts the app. */
export async function switchChannelAndReload(channel: string | null) {
  await setPreviewChannelOverride(channel);
  const result = await fetchLatestUpdateAndReload();
  return result === "up-to-date" ? ("no-update" as const) : result;
}

/** Pull the newest update for whatever channel the app is already pointed at
 * — the check/fetch/reload dance minus the override write. checkForUpdateAsync
 * compares the channel's latest against the RUNNING update, so calling this
 * again right after the reload finds nothing and terminates. */
export async function fetchLatestUpdateAndReload() {
  const result = await Updates.checkForUpdateAsync();
  if (!result.isAvailable) {
    return "up-to-date" as const;
  }
  await Updates.fetchUpdateAsync();
  await Updates.reloadAsync();
  return "reloading" as const;
}
