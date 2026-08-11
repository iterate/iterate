// Once-per-bundle boot claim, backing the "run something whenever new JS
// loads" hook (index.tsx uses it to decide whether the bundle's expected
// backend may interrupt the fast boot path). Separate from
// expected-backend.ts so that module stays pure for the node vitest lane —
// AsyncStorage drags in react-native.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { buildInfo } from "./build-info.ts";

const LAST_SEEN_BUNDLE_KEY = "expected-backend.last-seen-bundle";

/**
 * True throughout the first boot of a stamped bundle: the process launched
 * by ANY route to new JS (QR channel switch, auto-pulled OTA on relaunch,
 * fresh native install). The expectation is baked in permanently, so this is
 * what keeps "this bundle expects preview_3" a first-boot offer instead of a
 * nag on every boot after the user deliberately points elsewhere. builtAt
 * makes the identity unique per publish; unstamped local bundles ("" — which
 * also carry no expectation) never claim.
 *
 * Memoized per JS process (a new bundle IS a new process): the storage
 * claim happens once, and every later call — the bootstrap query refetches
 * on app focus — sees the same answer instead of consuming the claim and
 * yanking the offer away mid-look.
 */
export function claimNewBundleBoot(): Promise<boolean> {
  claimed ||= (async () => {
    if (!buildInfo.builtAt) return false;
    const id = `${buildInfo.commit}@${buildInfo.builtAt}`;
    const seen = await AsyncStorage.getItem(LAST_SEEN_BUNDLE_KEY);
    if (seen === id) return false;
    await AsyncStorage.setItem(LAST_SEEN_BUNDLE_KEY, id);
    return true;
  })();
  return claimed;
}

let claimed: Promise<boolean> | null = null;

/** The decline path: "keep my current setup" ends the offer for this
 * process too (it would otherwise hold for the whole first boot). */
export function dismissNewBundleBoot(): void {
  claimed = Promise.resolve(false);
}
