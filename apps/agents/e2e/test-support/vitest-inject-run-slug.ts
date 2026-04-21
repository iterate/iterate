import { inject } from "vitest";
import { VITEST_RUN_SLUG_KEY } from "./vitest-naming.ts";

/** Vitest `provide` keys are not augmented for `inject()` in all TS setups; cast at this boundary only. */
export function injectVitestRunSlug(): string {
  return inject(VITEST_RUN_SLUG_KEY as never) as string;
}
