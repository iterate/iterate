import type { Plugin, LocatorWithOriginal } from "../playwright-plugin.ts";

export type HydrationWaiterOptions = {
  /** Selector for unhydrated state. Default: '[data-hydrated="false"]' */
  selector?: string;
  /** Timeout for hydration. Default: 10_000 */
  timeout?: number;
  /** Whether to skip this plugin. Default: false */
  disabled?: boolean;
};

/**
 * Waits for the app to be hydrated before any locator action.
 * Looks for `[data-hydrated="false"]` and waits for it to disappear.
 */
export const hydrationWaiter = (options: HydrationWaiterOptions = {}): Plugin => {
  const selector = options.selector ?? '[data-hydrated="false"]';
  const timeout = options.timeout ?? 10_000;

  return {
    name: "hydration-waiter",
    middleware: async ({ page }, next) => {
      if (options.disabled) return next();

      const unhydratedLocator = page.locator(selector) as LocatorWithOriginal;
      const isUnhydrated = await unhydratedLocator.isVisible();

      if (isUnhydrated) {
        await unhydratedLocator.waitFor_original({ state: "hidden", timeout });
      }

      return next();
    },
  };
};
