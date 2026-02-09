import { AsyncLocalStorage } from "node:async_hooks";
import type { Locator } from "@playwright/test";
import type { Plugin, LocatorWithOriginal, OneArgMethod } from "../playwright-plugin.ts";
import { oneArgMethods, adjustError } from "../playwright-plugin.ts";

export type SpinnerWaiterSettings = {
  /** Selectors that indicate loading state */
  spinnerSelectors?: string[];
  /** Max time to wait for spinners (ms). Default: 30_000 */
  spinnerTimeout?: number;
  /** Whether to skip spinner checking. Default: false */
  disabled?: boolean;
  /** Debug logging function */
  log?: (message: string) => void;
};

/** @deprecated Use SpinnerWaiterSettings instead */
export type SpinnerWaiterOptions = SpinnerWaiterSettings;

const defaultSelectors = [
  `[aria-label="Loading"]`,
  `[data-spinner='true']`,
  `:text-matches("(loading|pending|creating|verifying|starting|processing|syncing)\\.\\.\\.$", "i")`,
];

const defaults: Required<SpinnerWaiterSettings> = {
  spinnerSelectors: defaultSelectors,
  spinnerTimeout: 30_000,
  disabled: false,
  log: () => {},
};

/** AsyncLocalStorage for runtime settings override */
const settingsStorage = new AsyncLocalStorage<Partial<SpinnerWaiterSettings>>();

const getSettings = (baseOptions: SpinnerWaiterSettings = {}) => {
  const runtimeOverrides = settingsStorage.getStore() ?? {};
  const result = { ...defaults, ...baseOptions, ...runtimeOverrides };
  if (result.spinnerTimeout <= 3000) {
    throw new Error("spinnerTimeout must be greater than 3000ms");
  }
  return result;
};

const suggestSpinnerMessage = (spinnerLocator: Locator) => [
  `If this is a slow operation, update the product code to add a spinner while it's running.`,
  `This will improve the user experience and buy you more time for this assertion.`,
  `To add a spinner, show any UI element matching this locator:`,
  `  ${spinnerLocator}`,
];

/**
 * Creates a spinner-waiter plugin.
 * Runtime settings can be overridden via `spinnerWaiter.settings.enterWith(...)`.
 */
export const spinnerWaiter = Object.assign(
  (options: SpinnerWaiterSettings = {}): Plugin => {
    return {
      name: "spinner-waiter",

      middleware: async ({ locator, method, args, page }, next) => {
        const settings = getSettings(options);
        if (settings.disabled) return next();

        // Check for skipSpinnerCheck in action options
        const optionIndex = oneArgMethods.includes(method as OneArgMethod) ? 1 : 0;
        const actionOptions = (args.at(optionIndex) || {}) as { skipSpinnerCheck?: boolean };
        if (actionOptions.skipSpinnerCheck) return next();

        settings.log(`${locator}.${method}(...) starting`);

        // Quick check if element is already visible
        const elementVisible = await waitForVisible(locator, { timeout: 1000 });
        if (elementVisible) {
          settings.log(`${locator} already visible, proceeding`);
          return next();
        }

        // Check for spinner
        const spinnerSelector = settings.spinnerSelectors.join(",");
        const spinnerLocator = page.locator(spinnerSelector) as LocatorWithOriginal;
        const spinnerVisible = await spinnerLocator.isVisible();

        if (!spinnerVisible) {
          // No spinner - call action, suggest adding one if it fails
          settings.log(`${locator} not visible, no spinner, proceeding anyway`);
          try {
            return await next();
          } catch (error) {
            adjustError(error as Error, suggestSpinnerMessage(spinnerLocator), "spinner-waiter.ts");
            throw error;
          }
        }

        settings.log(
          `Spinner visible, waiting up to ${settings.spinnerTimeout - 2000}ms for ${locator}`,
        );

        // Spinner is visible - wait longer for the element
        const appeared = await waitForVisible(locator, {
          timeout: settings.spinnerTimeout - 2000,
        });

        if (appeared) {
          settings.log(`${locator} appeared after waiting`);
          return next();
        }

        // Element still not visible - check if spinner is stuck
        const spinnerStillVisible = await spinnerLocator.isVisible();
        if (spinnerStillVisible) {
          settings.log(`Spinner still visible after ${settings.spinnerTimeout}ms, UI likely stuck`);
        } else {
          settings.log(`Spinner gone but element not visible`);
        }

        // Call action anyway (will likely fail), adjust error message
        try {
          return await next();
        } catch (error) {
          const message = spinnerStillVisible
            ? `Spinner was still visible after ${settings.spinnerTimeout}ms, the UI is likely stuck.`
            : `Neither spinner nor the element is visible after ${settings.spinnerTimeout}ms.`;
          adjustError(error as Error, [message], "spinner-waiter.ts");
          throw error;
        }
      },
    };
  },
  {
    /** Runtime settings override via AsyncLocalStorage */
    settings: settingsStorage,
    /** Default settings values */
    defaults,
  },
);

async function waitForVisible(locator: Locator, { timeout = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await locator.isVisible()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export { defaultSelectors };
