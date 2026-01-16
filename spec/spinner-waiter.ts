import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Locator, type Frame, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const { setBoxedStackPrefixes } = require("playwright-core/lib/utils");

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

export const spinnerWaiter = { setup, swap, settings, defaults };

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

function swap(page: Page) {
  const proxy = new Proxy(page, {
    get(pageTarget, pageProp) {
      if (pageProp === "_mainFrame") {
        return new Proxy(pageTarget.mainFrame(), {
          get(mainFrameTarget, mainFrameProp) {
            const value = mainFrameTarget[mainFrameProp as keyof Frame];
            if (mainFrameProp === "locator") {
              return new Proxy(value as {} as Locator, {
                get(locatorTarget, locatorProp) {
                  if (overrideableMethods.includes(locatorProp as OverrideableMethod)) {
                    return (...args: unknown[]) => {
                      console.log(`CALL!!!! ${String(locatorProp)}(...)`, args);
                      return (locatorTarget[locatorProp as keyof Locator] as Function)(...args);
                    };
                  }
                },
              });
            }
            return value;
          },
        });
      }
      return pageTarget[pageProp as keyof Page];
    },
  });
  return proxy;
}

function setup(page: Page) {
  // undocumented playwright feature: library code is excluded from call stacks in html viewers, traces etc.
  // Add this file so that we say spec's `await page.locator(...).click()` expression rather than an unhelpful
  // line from this file like `return (this[`${method}_original`] as Function)(...argsList)`
  setBoxedStackPrefixes([
    path.dirname(require.resolve("@playwright/test/package.json")),
    path.dirname(require.resolve("playwright/package.json")),
    path.dirname(require.resolve("playwright-core/package.json")),
    import.meta.filename,
  ]);

  const dummyLocator = page.locator("body");
  const locatorPrototype = dummyLocator.constructor.prototype;

  for (const method of overrideableMethods) {
    if (locatorPrototype[`${method}_original`]) continue;

    locatorPrototype[`${method}_original`] = locatorPrototype[method];
    let value: (this: LocatorWithOriginal, ...args: unknown[]) => Promise<unknown>;
    const impl = (process.env.SPINNER_WAITER_IMPL || "loop") as "loop" | "race";
    if (impl === "loop") {
      value = getLoopUntilVisibleImpl(method);
    } else if (impl === "race") {
      value = getRaceImpl(method);
    } else {
      impl satisfies never;
      throw new Error(`Unknown spinner waiter implementation: ${impl}`);
    }
    Object.defineProperty(locatorPrototype, method, { value });
  }
}

const getLoopUntilVisibleImpl = (method: OverrideableMethod) => {
  return async function loopUntilVisibleImpl(this: LocatorWithOriginal, ...args: unknown[]) {
    const optionIndex = oneArgMethods.includes(method as OneArgMethod) ? 1 : 0;
    const _options = (args.at(optionIndex) || {}) as Options<OverrideableMethod>;
    const settings = getSettings();
    const skipSpinnerCheck = settings.disabled || !!_options?.skipSpinnerCheck;

    settings.log(`${this}.${method}(...) ${JSON.stringify({ skipSpinnerCheck })}`);
    let called = false;

    const callOriginal = async (argsList: unknown[]) => {
      if (called) {
        throw new Error("callOriginal called more than once, this is a bug in spinner-waiter");
      }
      const options = argsList.at(-1) as { trial?: boolean } | undefined;
      called = !options?.trial;
      return (this[`${method}_original`] as Function)(...argsList);
    };

    if (skipSpinnerCheck) {
      return await callOriginal(args).catch((e) => {
        adjustError(e);
        throw e;
      });
    }
    const waitForVisible = async (locator: Locator, { timeout = 1000 } = {}) => {
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (await locator.isVisible()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };

    const elementVisible = await waitForVisible(this);
    if (elementVisible) {
      return await callOriginal(args).catch((e) => {
        adjustError(e);
        throw e;
      });
    }
    const spinnerSelector = settings.spinnerSelectors.join(",");
    const spinnerLocator = this.page().locator(spinnerSelector) as LocatorWithOriginal;

    const spinnerVisible = await spinnerLocator.isVisible();
    if (!spinnerVisible) {
      return await callOriginal(args).catch((e) => {
        adjustError(e, [
          `If this is a slow operation, update the product code to add a spinner while it's running.`,
          `This will improve the user experience and buy you more time for this assertion.`,
          `To add a spinner, show any UI element matching this locator:`,
          `  ${spinnerLocator}`,
        ]);
        throw e;
      });
    }

    const howBoutNow = await waitForVisible(this, {
      timeout: settings.spinnerTimeout - 2000,
    });

    if (howBoutNow) {
      return await callOriginal(args).catch((e) => {
        adjustError(e);
        throw e;
      });
    }

    const spinnerStillVisible = await spinnerLocator.isVisible();
    return await callOriginal(args).catch((e) => {
      const message = spinnerStillVisible
        ? `Spinner was still visible after ${settings.spinnerTimeout}ms, the UI is likely stuck.`
        : `Neither spinner nor the element is visible after ${settings.spinnerTimeout}ms`;
      adjustError(e, [message]);
      throw e;
    });

    // return spinnerLocator.waitFor_original({ timeout: 100, state: "hidden" }).catch((e: Error) => {
    //   adjustError(e, [
    //     `The loading spinner is no longer visible but ${this}.${method} didn't succeed, make sure the spinner stays visible until the operation is complete.`,
    //   ]);
    //   throw e;
    // });
  };
};

const getRaceImpl = (method: OverrideableMethod) => {
  return async function raceImpl(this: LocatorWithOriginal, ...args: unknown[]) {
    const optionIndex = oneArgMethods.includes(method as OneArgMethod) ? 1 : 0;
    const _options = (args.at(optionIndex) || {}) as Options<OverrideableMethod>;
    const argsWithoutOptions = args.slice(0, optionIndex);
    const settings = getSettings();
    const skipSpinnerCheck = settings.disabled || _options?.skipSpinnerCheck;

    settings.log(`${this}.${method}(...) ${JSON.stringify({ skipSpinnerCheck })}`);
    let called = false;

    const callOriginal = async (argsList: unknown[]) => {
      if (called) {
        throw new Error("callOriginal called more than once, this is a bug in spinner-waiter");
      }
      const options = argsList.at(-1) as { trial?: boolean } | undefined;
      called = !options?.trial;
      return (this[`${method}_original`] as Function)(...argsList);
    };

    if (skipSpinnerCheck) {
      return await callOriginal(args).catch((e) => {
        adjustError(e);
        throw e;
      });
    }

    const spinnerSelector = settings.spinnerSelectors.join(",");
    const spinnerLocator = this.page().locator(spinnerSelector) as LocatorWithOriginal;
    const union = this.or(spinnerLocator).first() as LocatorWithOriginal;

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
      `${this} not visible, but the spinner is. racing between ${this}.${method}(...) and ${spinnerLocator} being hidden`,
    );

    const race = await Promise.race([
      callOriginal([
        ...argsWithoutOptions,
        { ..._options, timeout: settings.spinnerTimeout - 1000, trial: true },
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
      return await callOriginal(args).catch((e) => {
        adjustError(e as Error);
        throw e;
      });
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
  };
};

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
