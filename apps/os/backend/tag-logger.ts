import { AsyncLocalStorage } from "async_hooks";

export namespace TagLogger {
  export type Level = keyof typeof TagLogger.levels;
  export type Context = {
    level: TagLogger.Level;
    tags: string[];
    logs: Array<{ level: TagLogger.Level; timestamp: Date; prefix: string[]; args: unknown[] }>;
  };
}

export class TagLogger {
  static levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;

  _storage = new AsyncLocalStorage<TagLogger.Context>();

  constructor(readonly _implementation = console as Pick<typeof console, TagLogger.Level>) {}

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
    return this.context.tags;
  }

  get prefix() {
    if (this.tags.length === 0) return [];
    return [this.tags.map((c) => `[${c}]`).join("")];
  }

  /** wrapper for `_storage.enterWith` - adds tags to the current async context */
  setTag(...tags: string[]) {
    this._storage.enterWith({ ...this.context, tags: [...this.context.tags, ...tags] });
  }

  /**
   * may not be the best way retrieve stuff from context, but useful in a pinch: if you've set tags in the form `foo=bar` you can retrieve
   * them anywhere in the async context with this: `logger.getTag('foo') // return 'bar'`
   */
  getTag(name: string) {
    return new URLSearchParams(this.tags.join("&")).get(name);
  }

  run<T>(tag: string | string[], fn: () => T): T {
    return this._storage.run({ ...this.context, tags: this.context.tags.concat(tag) }, fn);
  }

  tag(tag: string | string[]) {
    return {
      info: (...args: unknown[]) => this.run(tag, () => this.info(...args)),
      warn: (...args: unknown[]) => this.run(tag, () => this.warn(...args)),
      error: (...args: unknown[]) => this.run(tag, () => this.error(...args)),
      debug: (...args: unknown[]) => this.run(tag, () => this.debug(...args)),
    };
  }

  _log({ level, args, forget }: { level: TagLogger.Level; args: unknown[]; forget?: boolean }) {
    if (!forget)
      this.context.logs.push({ level, timestamp: new Date(), prefix: this.prefix, args });

    if (this.levelNumber > TagLogger.levels[level]) return;
    this._implementation[level](...this.prefix, ...args);
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

  error(...args: unknown[]) {
    this._log({ level: "error", args: args.concat(this.memories()) });
  }

  memories() {
    if (this.context.logs.length === 0) return [];
    return [
      "memories:",
      ...this.context.logs.map((log) => [
        log.timestamp.toISOString(),
        log.level,
        ...log.prefix,
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

/* eslint-disable no-console -- this is the one place where we use console */
export const logger = new TagLogger({
  // cloudflare ignores everything after the first arg
  debug: (...args) => (args.length === 0 ? console.debug(args[0]) : console.debug(args)),
  info: (...args) => (args.length === 0 ? console.info(args[0]) : console.info(args)),
  warn: (...args) => (args.length === 0 ? console.warn(args[0]) : console.warn(args)),
  error: (...args) => (args.length === 0 ? console.error(args[0]) : console.error(args)),
});
