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

/** Switch channel, then pull whatever it has. Returns what happened so the
 * caller can show it; only "reloading" actually restarts the app. */
export async function switchChannelAndReload(channel: string | null) {
  await setPreviewChannelOverride(channel);
  const result = await Updates.checkForUpdateAsync();
  if (!result.isAvailable) {
    return "no-update" as const;
  }
  await Updates.fetchUpdateAsync();
  await Updates.reloadAsync();
  return "reloading" as const;
}
