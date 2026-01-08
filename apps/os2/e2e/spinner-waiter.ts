import { AsyncLocalStorage } from "async_hooks";
import { Locator, type Page } from "@playwright/test";

export namespace spinnerWaiter {
  export type Settings = {
    spinnerTimeout: number;
    disabled: boolean;
    log: (message: string) => void;
  };
}

const settings = new AsyncLocalStorage<Partial<spinnerWaiter.Settings>>();

const defaults: spinnerWaiter.Settings = { spinnerTimeout: 30_000, disabled: false, log: () => {} };

export const spinnerWaiter = { setup, settings, defaults };

const getSettings = () => {
  return { ...defaults, ...settings.getStore() };
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

type LocatorWithOriginal = Locator & {
  [K in OverrideableMethod as `${K}_original`]: Locator[K];
};

function setup(page: Page) {
  // get a dummy locator so we can mess with the Locator class prototype (playwright doesn't expose the class directly just the interface)
  const dummyLocator = page.locator("body");
  const locatorPrototype = dummyLocator.constructor.prototype;

  // override the `.click` method on the prototype, not just this instance:
  for (const method of overrideableMethods) {
    locatorPrototype[`${method}_original`] = locatorPrototype[method];
    Object.defineProperty(locatorPrototype, method, {
      value: async function (this: LocatorWithOriginal, options: any) {
        const settings = getSettings();
        const skipSpinnerCheck = settings.disabled || options?.skipSpinnerCheck;

        settings.log(`${this}.${method}(...) ${JSON.stringify({ skipSpinnerCheck })}`);

        if (skipSpinnerCheck) {
          return await this[`${method}_original`](options).catch((e) => {
            adjustError(e);
            throw e;
          });
        }

        const spinnerLocator = this.page().locator(
          `[data-spinner],[data-spinner='true'],:text-matches("loading\\.\\.\\.$", "i")`,
        ) as LocatorWithOriginal;
        const union = this.or(spinnerLocator) as LocatorWithOriginal;

        settings.log(`waiting for union ${union}`);

        await union.waitFor_original().catch((e) => {
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
          // seems it's ready, just do the original operation
          return await this[`${method}_original`](options).catch((e) => {
            adjustError(e as Error, []);
            throw e;
          });
        }

        settings.log(
          `${this} not visible. racing between ${this}.${method}(...) and ${spinnerLocator} being hidden`,
        );

        const race = await Promise.race([
          this[`${method}_original`]({ ...options, timeout: settings.spinnerTimeout }).then(
            (result) => {
              return { outcome: "success" as const, result };
            },
          ),
          spinnerLocator
            .waitFor_original({ timeout: settings.spinnerTimeout, state: "hidden" })
            .then((result) => {
              return { outcome: "spinner-hidden" as const, result };
            }),
        ]).catch((e) => {
          adjustError(e as Error, [
            `${this}.${method}(...) didn't succeed and spinner was still visible after ${settings.spinnerTimeout}ms, the UI is likely stuck.`,
          ]);
          throw e;
        });

        settings.log(`race result: ${JSON.stringify(race)}`);

        if (race.outcome === "success") {
          return race.result;
        }

        if (race.outcome === "spinner-hidden") {
          // spinner was hidden before the operation completed, give it one last chance
          return await this[`${method}_original`](options).catch((e) => {
            adjustError(e as Error, [
              `The loading spinner is no longer visible but ${this}.${method} didn't succeed, make sure the spinner stays visible until the operation is complete.`,
            ]);
            throw e;
          });
        }

        race satisfies never;
        throw new Error(`Unknown race outcome: ${JSON.stringify(race)}`);
      },
    });
  }
}

/**
 * modifies an error's message and stack to include additional information, and exclude call stack frames from this file
 * (playwright shows a mini source code preview based on the top of the stack trace)
 */
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
