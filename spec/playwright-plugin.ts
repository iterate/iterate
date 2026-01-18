import { createRequire } from "node:module";
import * as path from "node:path";
import Emittery from "emittery";
import type { Locator, Page, TestInfo } from "@playwright/test";

const require = createRequire(import.meta.url);
const { setBoxedStackPrefixes } = require("playwright-core/lib/utils");

// Methods that take an extra argument before options (e.g., fill(value, options))
const oneArgMethods = ["fill", "type", "press"] as const;
type OneArgMethod = (typeof oneArgMethods)[number];

const overrideableMethods = [
  "click",
  "waitFor",
  "clear",
  "dblclick",
  "blur",
  "focus",
  "hover",
  ...oneArgMethods,
] satisfies (keyof Locator)[];
type OverrideableMethod = (typeof overrideableMethods)[number];

export type LocatorWithOriginal = Locator & {
  [K in OverrideableMethod as `${K}_original`]: Locator[K];
};

/**
 * Append info to an error message and clean up stack trace.
 * @param error - The error to modify
 * @param info - Lines to append to the error message
 * @param filterFile - Filename to remove from stack trace (e.g., "my-plugin.ts")
 * @param color - ANSI color code (default: 33 = yellow). Use 31 for red.
 */
export const adjustError = (
  error: Error,
  info: string[],
  filterFile?: string,
  { color = 33 } = {},
) => {
  if (!error?.message) return;

  Object.assign(error, { originalMessage: error.message, originalStack: error.stack });

  if (info.length > 0) {
    const infoBlock = info.map((line) => `  ${line}`).join("\n");
    error.message = `${error.message}\n\x1b[${color}m${infoBlock}\x1b[0m\n`;
  }

  if (filterFile && error.stack) {
    error.stack = error.stack
      .split("\n")
      .filter((line) => !line.includes(filterFile))
      .join("\n");
  }
};

export type ActionContext = {
  locator: LocatorWithOriginal;
  method: OverrideableMethod;
  args: unknown[];
  page: Page;
};

/** Function that calls the next middleware or the original action */
export type NextFn = () => Promise<unknown>;

/** Middleware function - wraps an action, must call next() */
export type ActionMiddleware = (ctx: ActionContext, next: NextFn) => Promise<unknown>;

export type TestLifecycleEvents = {
  beforeTest: { page: Page; testInfo: TestInfo };
  afterTest: { page: Page; testInfo: TestInfo };
};

export type Plugin = {
  name: string;
  /** Middleware to wrap locator actions. Called in registration order. */
  middleware?: ActionMiddleware;
  /** Subscribe to test lifecycle events */
  testLifecycle?: (emitter: Emittery<TestLifecycleEvents>) => void | (() => void);
};

const PLUGIN_STATE = Symbol("playwrightPluginState");

type PluginState = {
  actionMiddlewares: ActionMiddleware[];
  lifecycleEmitter: Emittery<TestLifecycleEvents>;
  lifecycleCleanups: (() => void)[];
};

type PageWithPlugins = Page & {
  [PLUGIN_STATE]: PluginState;
  [Symbol.asyncDispose]: () => Promise<void>;
};

// Track if Locator prototype has been patched
let prototypePatched = false;

/** Get plugin state from a page */
const getPluginState = (page: Page): PluginState | undefined => {
  return (page as PageWithPlugins)[PLUGIN_STATE];
};

/**
 * Add plugins to a page. Returns a disposable page that cleans up on dispose.
 *
 * @example
 * ```ts
 * await using page = await addPlugins(basePage, testInfo, [
 *   hydrationWaiter(),
 *   spinnerWaiter(),
 *   videoMode(),
 * ]);
 * ```
 */
export const addPlugins = async (
  page: Page,
  testInfo: TestInfo,
  plugins: (Plugin | false | null | undefined)[],
): Promise<PageWithPlugins> => {
  // Patch Locator prototype once globally
  patchLocatorPrototype(page);

  // Initialize state on page
  const state: PluginState = {
    actionMiddlewares: [],
    lifecycleEmitter: new Emittery(),
    lifecycleCleanups: [],
  };

  // Register plugins
  for (const plugin of plugins) {
    if (!plugin) continue;

    if (plugin.middleware) {
      state.actionMiddlewares.push(plugin.middleware);
    }

    if (plugin.testLifecycle) {
      const cleanup = plugin.testLifecycle(state.lifecycleEmitter);
      if (cleanup) state.lifecycleCleanups.push(cleanup);
    }
  }

  const pageWithPlugins = page as PageWithPlugins;
  pageWithPlugins[PLUGIN_STATE] = state;

  // Emit beforeTest
  await state.lifecycleEmitter.emitSerial("beforeTest", { page, testInfo });

  // Add async dispose
  pageWithPlugins[Symbol.asyncDispose] = async () => {
    await state.lifecycleEmitter.emitSerial("afterTest", { page, testInfo });
    state.lifecycleCleanups.forEach((cleanup) => cleanup());
  };

  return pageWithPlugins;
};

/** Patch Locator prototype to run middleware. Safe to call multiple times. */
const patchLocatorPrototype = (page: Page) => {
  if (prototypePatched) return;
  prototypePatched = true;

  // Exclude this file from stack traces in Playwright reports
  if (!process.env.PLAYWRIGHT_PLUGIN_DEBUG) {
    setBoxedStackPrefixes([
      path.dirname(require.resolve("@playwright/test/package.json")),
      path.dirname(require.resolve("playwright/package.json")),
      path.dirname(require.resolve("playwright-core/package.json")),
      import.meta.filename,
    ]);
  }

  const dummyLocator = page.locator("body");
  const locatorPrototype = dummyLocator.constructor.prototype;

  for (const method of overrideableMethods) {
    locatorPrototype[`${method}_original`] = locatorPrototype[method];

    const value = async function patchedMethod(
      this: LocatorWithOriginal,
      ...args: unknown[]
    ): Promise<unknown> {
      const state = getPluginState(this.page());
      const actionMiddlewares = state?.actionMiddlewares ?? [];

      const ctx: ActionContext = { locator: this, method, args, page: this.page() };

      // Build middleware chain - each middleware calls next() to continue
      const callOriginal = () => (this[`${method}_original`] as Function)(...args);

      let index = 0;
      const next: NextFn = async () => {
        if (index < actionMiddlewares.length) {
          const middleware = actionMiddlewares[index++];
          return middleware(ctx, next);
        }
        return callOriginal();
      };

      return next();
    };

    Object.defineProperty(locatorPrototype, method, { value });
  }
};

// Re-export types for plugin authors
export type { OverrideableMethod, OneArgMethod };
export { oneArgMethods, overrideableMethods };
