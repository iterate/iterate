// Once-per-bundle boot claim, backing the "run something whenever new JS
// loads" hook (index.tsx uses it to decide whether the bundle's expected
// backend may interrupt the fast boot path). Separate from
// expected-backend.ts so that module stays pure for the node vitest lane —
// AsyncStorage drags in react-native.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { buildInfo } from "./build-info.ts";

const LAST_SEEN_BUNDLE_KEY = "expected-backend.last-seen-bundle";

/**
 * True exactly once per stamped bundle: the first boot after ANY route
 * loaded new JS (QR channel switch, auto-pulled OTA on relaunch, fresh
 * native install). The expectation is baked in permanently, so this is what
 * keeps "this bundle expects preview_3" a one-time offer instead of a nag on
 * every boot after the user deliberately points elsewhere. builtAt makes the
 * identity unique per publish; unstamped local bundles ("" — which also
 * carry no expectation) never claim.
 */
export async function claimNewBundleBoot(): Promise<boolean> {
  if (!buildInfo.builtAt) return false;
  const id = `${buildInfo.commit}@${buildInfo.builtAt}`;
  const seen = await AsyncStorage.getItem(LAST_SEEN_BUNDLE_KEY);
  if (seen === id) return false;
  await AsyncStorage.setItem(LAST_SEEN_BUNDLE_KEY, id);
  return true;
}
