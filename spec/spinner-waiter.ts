import { AsyncLocalStorage } from "node:async_hooks";
import { Locator, type Page } from "@playwright/test";

export namespace spinnerWaiter {
  export type Settings = {
    spinnerSelectors: string[];
    spinnerTimeout: number;
    disabled: boolean;
    log: (message: string) => void;
  };
}

const settings = new AsyncLocalStorage<Partial<spinnerWaiter.Settings>>();

const defaults: spinnerWaiter.Settings = {
  spinnerSelectors: [
    `[aria-label="Loading"]`,
    `[data-spinner='true']`,
    `:text-matches("(loading|pending|creating)\\.\\.\\.$", "i")`,
    `[data-hydrated='false']`, // app is not hydrated yet
  ],
  spinnerTimeout: 30_000,
  disabled: false,
  log: () => {},
};

export const spinnerWaiter = { setup, settings, defaults };

const getSettings = () => {
  const result = { ...defaults, ...settings.getStore() };
  if (result.spinnerTimeout <= 1000) throw new Error("spinnerTimeout must be greater than 1000ms");
  return result;
};

const oneArgMethods = ["fill", "type", "press"] as const;
type OneArgMethod = (typeof oneArgMethods)[number];

const overrideableMethods = [
  "click",
  "waitFor",
  "clear",
  "dblclick",
  "blur",
  "focus",
  ...oneArgMethods,
] satisfies (keyof Locator)[];
type OverrideableMethod = (typeof overrideableMethods)[number];

type Options<M extends OverrideableMethod> = (M extends OneArgMethod
  ? Parameters<Locator[M]>[1]
  : Parameters<Locator[M]>[0]) & { skipSpinnerCheck?: boolean };

export type LocatorWithOriginal = Locator & {
  [K in OverrideableMethod as `${K}_original`]: Locator[K];
};

function setup(page: Page) {
  const dummyLocator = page.locator("body");
  const locatorPrototype = dummyLocator.constructor.prototype;

  for (const method of overrideableMethods) {
    if (locatorPrototype[`${method}_original`]) continue;

    locatorPrototype[`${method}_original`] = locatorPrototype[method];
    Object.defineProperty(locatorPrototype, method, {
      value: async function (this: LocatorWithOriginal, ...args: unknown[]) {
        const optionIndex = oneArgMethods.includes(method as OneArgMethod) ? 1 : 0;
        const options = (args.at(optionIndex) || {}) as Options<OverrideableMethod>;
        const settings = getSettings();
        const skipSpinnerCheck = settings.disabled || options?.skipSpinnerCheck;

        settings.log(`${this}.${method}(...) ${JSON.stringify({ skipSpinnerCheck })}`);

        const [attempt1] = await Promise.allSettled([
          (this[`${method}_original`] as Function)(...args),
        ]);

        if (attempt1.status === "fulfilled") {
          return attempt1.value;
        }

        if (skipSpinnerCheck) {
          // bad luck, attempt1 is all you get
          adjustError(attempt1.reason as Error);
          throw attempt1.reason;
        }

        let called = false;

        const callOriginal = async (argsList: unknown[]) => {
          if (called) {
            throw new Error("Original called more than once, this is a bug in spinner-waiter");
          }

          called = true;
          return (this[`${method}_original`] as Function)(...argsList);
        };

        const spinnerSelector = settings.spinnerSelectors.join(",");
        const spinnerLocator = this.page().locator(spinnerSelector) as LocatorWithOriginal;

        const spinnerVisible = await spinnerLocator.isVisible();

        if (!spinnerVisible) {
          adjustError(attempt1.reason as Error, [
            `If this is a slow operation, update the product code to add a spinner while it's running.`,
            `This will improve the user experience and buy you more time for this assertion.`,
            `To add a spinner, show any UI element matching this locator:`,
            `  ${spinnerLocator}`,
          ]);
          throw attempt1.reason;
        }

        settings.log(
          `${this} not visible, but the spinner is. racing between ${this}.${method}(...) and ${spinnerLocator} being hidden`,
        );

        const targetVisibleOrSpinnerRemoval = this.or(
          this.page().locator(`body:not(:has(${spinnerSelector}))`),
        ).first() as LocatorWithOriginal;

        const [attempt2] = await Promise.allSettled([
          targetVisibleOrSpinnerRemoval.waitFor_original({ timeout: settings.spinnerTimeout }),
        ]);

        if (attempt2.status === "rejected") {
          adjustError(attempt2.reason as Error, [
            `${this}.${method}(...) didn't succeed and spinner was still visible after ${settings.spinnerTimeout}ms, the UI is likely stuck.`,
          ]);
          throw attempt2.reason;
        }

        const targetVisible = await this.isVisible();

        if (!targetVisible) {
          // last chance, we expect to fail at this point
          return await callOriginal(args).catch((e) => {
            adjustError(e as Error, [
              `The loading spinner is no longer visible but ${this}.${method} didn't succeed, make sure the spinner stays visible until the operation is complete.`,
            ]);
            throw e;
          });
        }

        return await callOriginal(args).catch((e) => {
          adjustError(e as Error);
          throw e;
        });
      },
    });
  }
}

function adjustError(e: Error, info: string[] = []) {
  if (!e?.message) return;
  Object.assign(e, { originalMessage: e.message, originalStack: e.stack });

  const lines = e.message?.split("\n");
  lines[0] += `\x1b[33m`;
  info.forEach((line) => (lines[0] += `\n  ${line}`));
  lines[0] += `\x1b[0m`;

  e.message = lines.join("\n");
  e.stack = e.stack
    ?.split("\n")
    .filter((line: string) => !line.includes(import.meta.filename))
    .join("\n");
}
