import { AsyncLocalStorage } from "async_hooks";

export namespace TagLogger {
  export type Level = keyof typeof TagLogger.levels;
  export type Context = {
    level: TagLogger.Level;
    tags: Record<string, string>;
    logs: Array<{
      level: TagLogger.Level;
      timestamp: Date;
      tags: Record<string, string>;
      args: unknown[];
    }>;
    onError: (error: Error) => void;
  };
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
    "enterWith"
  >;

  defaultStore: TagLogger.Context | undefined;

  static consoleLogFn(console: TagLogger.ConsoleImplementation): TagLogger.LogFn {
    return function consoleLog({ level, args }) {
      const { onError } = this.context;
      args = JSON.parse(JSON.stringify(args, (_, value) => errorToPOJO(value, onError)));
      if (Object.keys(this.tags).length) console[level](this.tagsString(), ...args);
      else console[level](...args);
    };
  }

  private _logFn: TagLogger.LogFn;

  constructor(logFn: TagLogger.LogFn = TagLogger.consoleLogFn(console)) {
    this._logFn = logFn.bind(this);
  }

  get context(): TagLogger.Context {
    return (
      this._storage.getStore() ||
      this.defaultStore || { level: "info", tags: {}, logs: [], onError: () => {} }
    );
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
    return this.context.tags as Readonly<Record<string, string>>;
  }

  static encodeTagComponent(s: string) {
    const avoidEscaping = ["+", "/", ":", ".", "-", "_", "#"];
    let encoded = encodeURIComponent(s);
    avoidEscaping.forEach((char) => {
      encoded = encoded.replaceAll(encodeURIComponent(char), char);
    });
    return encoded;
  }

  static tagsToString(tags: Readonly<Record<string, string>>) {
    const encoded = Object.entries(tags).map(([key, value]) => {
      return `[${TagLogger.encodeTagComponent(key)}=${TagLogger.encodeTagComponent(value)}]`;
    });
    return encoded.join("");
  }

  tagsString() {
    return TagLogger.tagsToString(this.tags);
  }

  getTag(name: string): string | undefined {
    return this.tags[name];
  }

  parseTag(tag: string): [string, string] {
    const [name, rawValue] = tag.split("=");
    const searchParams = new URLSearchParams(tag);
    const value = searchParams.get(name) || "";
    if (rawValue && value && rawValue !== value) {
      this.warn(`tag ${JSON.stringify(tag)} was passed as a string but has invalid characters`);
    }
    return [name, value];
  }

  run<T>(tags: string | string[] | Record<string, string | undefined>, fn: () => T): T {
    let record: Record<string, string> = {};
    if (Array.isArray(tags)) {
      tags.forEach((tag) => {
        const [name, value] = this.parseTag(tag);
        record[name] = value;
      });
    } else if (typeof tags === "string") {
      const [name, value] = this.parseTag(tags);
      record[name] = value;
    } else {
      record = Object.fromEntries(
        Object.entries(tags).filter(([_, value]) => value !== undefined),
      ) as Record<string, string>;
    }

    const newContext: TagLogger.Context = {
      ...this.context,
      logs: [...this.context.logs],
      tags: { ...this.context.tags, ...record },
    };
    return this._storage.run(newContext, fn);
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

  _log({
    level,
    args,
    memories,
  }: {
    level: TagLogger.Level;
    args: unknown[];
    memories?: unknown[];
  }) {
    this.context.logs.push({ level, timestamp: new Date(), tags: { ...this.tags }, args });

    if (this.levelNumber > TagLogger.levels[level]) return;
    this._logFn({ level, args: args.concat(memories || []) });
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
    this._log({ level: "warn", args, memories: this.memories() });
  }

  error(error: Error): void;
  error(message: string, cause?: unknown): void;
  error(...args: unknown[]) {
    if (String(args[0]).includes("There is a new version of the pre-bundle")) {
      return;
    }
    this._log({ level: "error", args, memories: this.memories() });
  }

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
}

function errorToPOJO<T>(error: T, onError: (error: Error) => void): { [K in keyof T]: T[K] } {
  if (error instanceof Error) {
    type PlainError = {
      class: string;
      toString: () => string;
      rootCause: string;
    } & {
      [K in keyof Error]: Error[K];
    };

    const plain: PlainError = {
      rootCause: `${error.constructor.name}: ${error.message}`,
      toString: () => error.message,
      class: error.constructor.name,
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    if ("cause" in error) {
      const plainCause = errorToPOJO(error.cause, onError) as PlainError;
      plain.cause = plainCause;
      if (plainCause?.rootCause) {
        plain.rootCause = `${plain.rootCause}\n👆 ${plainCause.rootCause}`;
      }
    }

    Object.getOwnPropertyNames(error).forEach((key) => {
      if (!(key in plain)) {
        Object.assign(plain, { [key]: error[key as keyof Error] });
      }
    });

    onError(plain);

    return plain as T;
  }
  return error;
}

function getLogger() {
  const mode = import.meta.env?.MODE;
  if (mode === "test") {
    return new TagLogger(() => {});
  }
  if (mode === "development") {
    return new TagLogger(TagLogger.consoleLogFn(console));
  }

  return new TagLogger(function prodLog({ level, args }) {
    const toLog = {
      ...(typeof args[0] === "string" ? { message: args[0] } : {}),
      level,
      metadata: { ...this.tags },
      args,
      levelNumber: TagLogger.levels[level],
    };

    console.info(JSON.stringify(toLog, (_, value) => errorToPOJO(value, this.context.onError)));
  });
}

export const logger = getLogger();
