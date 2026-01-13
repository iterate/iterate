import { AsyncLocalStorage } from "node:async_hooks";
import { Locator, type Page } from "@playwright/test";

export namespace spinnerWaiter {
  export type Settings = {
    spinnerSelector: string;
    spinnerTimeout: number;
    disabled: boolean;
    log: (message: string) => void;
  };
}

const settings = new AsyncLocalStorage<Partial<spinnerWaiter.Settings>>();

const defaults: spinnerWaiter.Settings = {
  spinnerSelector: `[aria-label="Loading"],[data-spinner='true'],:text-matches("(loading|pending|creating)\\.\\.\\.$", "i")`,
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

const overrideableMethods = [
  "click",
  "waitFor",
  "fill",
  "clear",
  "dblclick",
  "press",
  "blur",
  "focus",
  "type",
] satisfies (keyof Locator)[];
type OverrideableMethod = (typeof overrideableMethods)[number];

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
        const _options = args.at(-1) as any;
        const settings = getSettings();
        const skipSpinnerCheck = settings.disabled || _options?.skipSpinnerCheck;

        settings.log(`${this}.${method}(...) ${JSON.stringify({ skipSpinnerCheck })}`);

        const callOriginal = async (argsList: unknown[]) =>
          (this[`${method}_original`] as Function)(...argsList);

        if (skipSpinnerCheck) {
          return await callOriginal(args).catch((e) => {
            adjustError(e);
            throw e;
          });
        }

        const spinnerLocator = this.page().locator(settings.spinnerSelector) as LocatorWithOriginal;
        const union = this.or(spinnerLocator) as LocatorWithOriginal;

        settings.log(`waiting for union ${union}`);

        await union.waitFor_original().catch((e: Error) => {
          const resolvedToTooMany = `${e}`.match(/resolved to \d+ elements/); // playwright throws when you match too many elements. this isn't spinner related.
          if (!resolvedToTooMany)
            adjustError(e, [
              `If this is a slow operation, update the product code to add a spinner while it's running.`,
              `This will improve the user experience and buy you more time for this assertion.`,
              `To add a spinner, show any UI element matching this locator:`,
              `  ${spinnerLocator}`,
            ]);
          throw e;
        });

        settings.log(`union gotten. ${this}.isVisible(): ${await this.isVisible()}`);

        if (await this.isVisible()) {
          return await callOriginal(args).catch((e) => {
            adjustError(e as Error, []);
            throw e;
          });
        }

        settings.log(
          `${this} not visible, but the spinner is. racing between ${this}.${method}(...) and ${spinnerLocator} being hidden.\n\n${await page.evaluate(() => document.querySelector(`[aria-label="Loading"],[data-spinner='true']`)?.outerHTML)}\n\n`,
        );

        const race = await Promise.race([
          callOriginal([
            ...args.slice(0, -1),
            { ..._options, timeout: settings.spinnerTimeout - 1000 },
          ])
            .then((result) => ({ outcome: "success" as const, result }))
            .catch((e) => ({ outcome: "error" as const, error: e })),
          spinnerLocator
            .waitFor_original({ timeout: settings.spinnerTimeout, state: "hidden" })
            .then((result: void) => ({ outcome: "spinner-hidden" as const, result }))
            .catch((e: Error) => ({ outcome: "error" as const, error: e })),
        ]);

        settings.log(`race result: ${JSON.stringify(race)}`);

        if (race.outcome === "error") {
          adjustError(race.error as Error, [
            `${this}.${method}(...) didn't succeed and spinner was still visible after ${settings.spinnerTimeout}ms, the UI is likely stuck.`,
          ]);
          throw race.error;
        }

        if (race.outcome === "success") {
          return race.result;
        }

        if (race.outcome === "spinner-hidden") {
          return await callOriginal(args).catch((e) => {
            adjustError(e as Error, [
              `The loading spinner is no longer visible but ${this}.${method} didn't succeed, make sure the spinner stays visible until the operation is complete.`,
            ]);
            throw e;
          });
        }

        throw new Error(`Unknown race outcome: ${JSON.stringify(race)}`);
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
