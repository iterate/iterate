// A fresh native install must overpower a lingering preview-channel
// override. The override persists natively across overwrite-installs, so
// without this, installing a PR's build (or a new main build) while an old
// override points at some other branch's channel means the app immediately
// OTA-pulls that channel's JS onto the new binary — you think you're running
// the build you installed, but you're not. On the first boot of a new binary
// the override is force-cleared (with a visible notice — see _layout.tsx),
// putting the build's own embedded channel back in charge; pointing at a PR
// channel again is one QR scan away.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import { Platform } from "react-native";
import * as Updates from "expo-updates";
import { getPreviewChannelOverride, setPreviewChannelOverride } from "./preview-channel.ts";

const LAST_SEEN_INSTALL_KEY = "native-install.last-seen";

/**
 * Clears a preview-channel override left over from before this binary was
 * installed; returns the cleared channel (to show the user), or null when
 * nothing changed. The binary identity is version/build-number/runtime — an
 * EAS install changes at least one of them. Deliberately inert when the
 * stored identity is missing (first run after this feature ships, or a
 * truly fresh install where there's no override anyway): only an observed
 * CHANGE of binary proves the override predates the install.
 */
export async function resetChannelOverrideForNewInstall(): Promise<string | null> {
  // Web has no installs; Metro dev bundles have no OTA for an override to hijack.
  if (Platform.OS === "web" || !Updates.isEnabled) return null;
  const id = `${Application.nativeApplicationVersion}/${Application.nativeBuildVersion}/${Updates.runtimeVersion}`;
  const seen = await AsyncStorage.getItem(LAST_SEEN_INSTALL_KEY);
  if (seen === id) return null;
  await AsyncStorage.setItem(LAST_SEEN_INSTALL_KEY, id);
  if (seen === null) return null;
  const override = await getPreviewChannelOverride();
  if (!override) return null;
  await setPreviewChannelOverride(null);
  return override;
}
