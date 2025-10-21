import { AsyncLocalStorage } from "async_hooks";
import { waitUntil } from "../env.ts";

export namespace TagLogger {
  export type Level = keyof typeof TagLogger.levels;
  export type Context = {
    level: TagLogger.Level;
    tags: string[];
    logs: Array<{
      level: TagLogger.Level;
      timestamp: Date;
      tags: string[];
      args: unknown[];
    }>;
  };
  /** "driver" for tag-logger. Expected to be responsible for printing logs to stdout/stdin. But if you want to email your grandma when we log an error, go for it. */
  export type ConsoleImplementation = Pick<typeof console, TagLogger.Level>;
  export type LogFn = (
    this: TagLogger,
    params: { level: TagLogger.Level; args: unknown[] },
  ) => void;
  export type Implementation = {
    debug: LogFn;
    info: LogFn;
    warn: LogFn;
    error: LogFn;
  };
}

export class TagLogger {
  static levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;

  _storage = new AsyncLocalStorage<TagLogger.Context>() as Omit<
    AsyncLocalStorage<TagLogger.Context>,
    "enterWith" // cloudflare workers doesn't support enterWith: https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/#caveats
  >;

  /**
   * A helper/reference implementation for if you want to use `console` and its various methods to print your logs.
   * It appends the tags string to the beginning of the log message. It's useful for dev/test etc. where you want to
   * use `console`'s default pretty-printing. Not so much if you want JSON logs.
   *
   * You could also pass in another compatible logger implementation, like `pino` or `winston` or `roarr` or whatever.
   * But if you are finding it annoying, don't bother with it. Just write a simple function yourself.
   */
  static consoleLogFn(console: TagLogger.ConsoleImplementation): TagLogger.LogFn {
    return function consoleLog({ level, args }) {
      if (this.tags.length) console[level](this.tagsString(), ...args);
      else console[level](...args);
    };
  }

  private _logFn: TagLogger.LogFn;

  constructor(logFn: TagLogger.LogFn = TagLogger.consoleLogFn(console)) {
    this._logFn = logFn.bind(this);
  }

  get context(): TagLogger.Context {
    return this._storage.getStore() || { level: "info", tags: [], logs: [] };
  }

  get level() {
    return this.context.level;
  }

  set level(level: TagLogger.Level) {
    if (!this._storage.getStore())
      throw new Error(`You can't set the level globally. Use .run(...) to scope`);
    this.context.level = level;
  }

  get levelNumber() {
    return TagLogger.levels[this.level];
  }

  get tags() {
    return this.context.tags as readonly string[];
  }

  /** 1-tuple of concatenated tags, or empty array if there are no tags. useful for `console.info(...logger.prefix, 123, 456)` */
  get prefixOLD(): [] | [Record<string, string>] {
    if (this.tags.length === 0) return [];
    const string = this.tagsString();
    const record = this.tagsRecord();
    // add magic symbol so that when using `console` as the implementation, the prefix is printed as a concise but readable string, not a big fat object
    // in environments like cloudflare logs/aws cloudwatch, this won't be used, and it'll be a nicely queryable fat object
    Object.defineProperty(record, Symbol.for("nodejs.util.inspect.custom"), {
      value: () => string,
      enumerable: false,
    });
    Object.defineProperty(record, "toString", {
      value: () => string,
      enumerable: false,
    });
    return [record];
  }

  static tagsToString(tags: readonly string[]) {
    return tags.map((c) => `[${c}]`).join("");
  }
  static tagsToRecord(tags: readonly string[]) {
    return Object.fromEntries(new URLSearchParams(tags.join("&")));
  }

  tagsString() {
    return TagLogger.tagsToString(this.tags);
  }

  tagsRecord() {
    return TagLogger.tagsToRecord(this.tags);
  }

  /**
   * may not be the best way retrieve stuff from context, but useful in a pinch: if you've set tags in the form `foo=bar` you can retrieve
   * them anywhere in the async context with this: `logger.getTag('foo') // return 'bar'`
   */
  getTag(name: string): string | undefined {
    return this.tagsRecord()[name];
  }

  run<T>(tag: string | string[], fn: () => T): T {
    return this._storage.run({ ...this.context, tags: this.context.tags.concat(tag) }, fn);
  }

  timed = Object.fromEntries(
    Object.keys(TagLogger.levels).map((level) => [
      level,
      async (tag: string, fn: () => Promise<unknown>) =>
        this.timedLog({
          tag,
          level: level as TagLogger.Level,
          getMessage: (params) => `${params.tag} took ${params.end - params.start}ms`,
          fn,
        }),
    ]),
  ) as {
    [K in TagLogger.Level]: (tag: string, fn: () => Promise<unknown>) => Promise<unknown>;
  };

  async timedLog<T>(params: {
    tag: string;
    level: TagLogger.Level;
    getMessage: (params: { tag: string; start: number; end: number }) => string;
    fn: () => Promise<T>;
  }): Promise<T> {
    const { tag, level, getMessage, fn } = params;
    const start = performance.now();
    const result = await this.run(tag, fn);
    const end = performance.now();
    this._log({ level, args: [getMessage({ tag, start, end })] });
    return result;
  }

  _log({ level, args, forget }: { level: TagLogger.Level; args: unknown[]; forget?: boolean }) {
    if (!forget)
      this.context.logs.push({ level, timestamp: new Date(), tags: this.tags.slice(), args });

    if (this.levelNumber > TagLogger.levels[level]) return;
    this._logFn({ level, args });
  }

  debug(...args: unknown[]) {
    this._log({ level: "debug", args });
  }

  /** @deprecated Use `info` instead */
  log(...args: unknown[]) {
    this._log({ level: "info", args });
  }

  info(...args: unknown[]) {
    this._log({ level: "info", args });
  }

  warn(...args: unknown[]) {
    this._log({ level: "warn", args: args.concat(this.memories()) });
  }

  error(error: Error): void;
  error(message: string, cause?: unknown): void;
  error(...args: unknown[]) {
    this._log({ level: "error", args: args.concat(this.memories()) });
  }

  /**
   * Somewhat opinionated way to recall what has been logged so far in the current async context.
   * Prepends with the string `memories:`, and each log is prepended with its timestamp, level, and prefix, converted to strings for readability.
   * If you want to keep the prefix as a record, override this method.
   */
  memories() {
    if (this.context.logs.length === 0) return [];
    return [
      "memories:",
      ...this.context.logs.map((log) => [
        log.timestamp.toISOString(),
        log.level,
        TagLogger.tagsToString(log.tags),
        ...log.args,
      ]),
    ];
  }

  /** Like `.run(...)`, but if there is an error, it will log the "memories" of its context, including all log levels, even debug */
  try<T>(tag: string, fn: () => Promise<T>): Promise<T> {
    return this.run(tag, async () => {
      try {
        return fn();
      } catch (error) {
        this.run("memories", () =>
          this._log({ level: "error", args: [this.memories()], forget: true }),
        );
        throw error;
      }
    });
  }
}

function serializeError<T>(error: T): { [K in keyof T]: T[K] } {
  if (error instanceof Error) {
    const plain: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    // Include cause if present (recursively serialize it)
    if (error.cause) {
      plain.cause = serializeError(error.cause);
    }

    // Include any additional enumerable properties
    Object.getOwnPropertyNames(error).forEach((key) => {
      if (!plain[key] && key !== "stack") {
        plain[key] = (error as typeof plain)[key];
      }
    });

    return plain as T;
  }
  return error;
}

class PosthogTagLogger extends TagLogger {
  error(...args: [Error] | [string, unknown?]) {
    super.error(...(args as Parameters<TagLogger["error"]>));
    waitUntil(
      Promise.resolve().then(async () => {
        const { PostHog } = await import("posthog-node");
        const { env } = await import("../env.ts");

        try {
          const error = args[0] instanceof Error ? args[0] : new Error(args[0], { cause: args[1] });
          const posthog = new PostHog(env.POSTHOG_PUBLIC_KEY, { host: "https://eu.i.posthog.com" });

          posthog.captureException(error, this.getTag("userId") || "anonymous", {
            environment: env.POSTHOG_ENVIRONMENT,
            ...this.tagsRecord(),
            memories: this.memories(),
          });

          await posthog.shutdown();
        } catch (trackingError) {
          // eslint-disable-next-line no-console -- Cannot use logger here as it would create infinite recursion
          console.error("Failed to track error:", trackingError);
        }
      }),
    );
  }
}

function getLogger() {
  if (import.meta.env.MODE === "test") {
    return new TagLogger(TagLogger.consoleLogFn(console));
  }
  if (import.meta.env.DOPPLER_ENVIRONMENT === "dev") {
    // we don't currently have import.meta.env.MODE for dev 🤷 - but we only want to use the vanilla console logger if we're definitely in a dev environment
    return new PosthogTagLogger(TagLogger.consoleLogFn(console));
  }

  return new TagLogger(function prodLog({ level, args }) {
    const toLog = {
      // let's make a special case for the first argument, which will very often be a string, to avoid having to search for `args[0]` in the dashboard all the time
      ...(typeof args[0] === "string" ? { message: args[0] } : {}),
      level,
      // spread metadata to get rid of Symbol.for("nodejs.util.inspect.custom") symbol
      metadata: this.tagsRecord(),
      // raw args
      args,
      // Same info as `level` but useful for filtering by `levelNumber >= 2` (warn or worse) in dashboards
      levelNumber: TagLogger.levels[level],
    };
    // for now let's use console.info always. But we could do `console[level](...)`, not sure if that'll work as well in Cloudflare/AWS CloudWatch/etc.
    // eslint-disable-next-line no-console -- only usage
    console.info(JSON.stringify(toLog, (_, value) => serializeError(value)));
  });
}

export const logger = getLogger();
