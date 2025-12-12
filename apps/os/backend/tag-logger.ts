import { AsyncLocalStorage } from "async_hooks";
import { waitUntil } from "../env.ts";

export namespace TagLogger {
  export type Level = keyof typeof TagLogger.levels;
  export type Context = {
    level: TagLogger.Level;
    tagsStringNicknames?: Record<string, string>;
    tags: Record<string, string>;
    logs: Array<{
      level: TagLogger.Level;
      timestamp: Date;
      tags: Record<string, string>;
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

  nickname() {
    return `log_${Math.random()}`.replace("0.", "").slice(0, 8);
  }

  _storage = new AsyncLocalStorage<TagLogger.Context>() as Omit<
    AsyncLocalStorage<TagLogger.Context>,
    "enterWith" // cloudflare workers doesn't support enterWith: https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/#caveats
  >;

  /** set this if you want to store logs/context *globally*. Otherwise, logs will only be stored when an async context is entered. */
  defaultStore: TagLogger.Context | undefined;

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
      args = JSON.parse(JSON.stringify(args, (_, value) => errorToPOJO(value)));
      if (Object.keys(this.tags).length) console[level](this.tagsString(), ...args);
      else console[level](...args);
    };
  }

  private _logFn: TagLogger.LogFn;

  constructor(logFn: TagLogger.LogFn = TagLogger.consoleLogFn(console)) {
    this._logFn = logFn.bind(this);
  }

  get context(): TagLogger.Context {
    return this._storage.getStore() || this.defaultStore || { level: "info", tags: {}, logs: [] };
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
      // unescape characters that don't cause problems in URL search params, so tags don't look too ugly in dev
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
    const str = TagLogger.tagsToString(this.tags);
    this.context.tagsStringNicknames ||= {};
    if (str in this.context.tagsStringNicknames) {
      return this.context.tagsStringNicknames[str];
    }

    const nickname = this.nickname();

    this.context.tagsStringNicknames[str] = nickname;
    return `\n${nickname}: ${str}`;
  }

  /**
   * may not be the best way retrieve stuff from context, but useful in a pinch: if you've set tags in the form `foo=bar` you can retrieve
   * them anywhere in the async context with this: `logger.getTag('foo') // return 'bar'`
   */
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
      logs: [...this.context.logs], // copy array since children will push to this
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
}

// #region: utils, could be moved to a separate file if needed

/** checks if value is error-like and swaps it out for a plain object which can be serialized to JSON, and has a `rootCause` property */
function errorToPOJO<T>(error: T): { [K in keyof T]: T[K] } {
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

    // Include cause if present (recursively serialize it)
    if ("cause" in error) {
      const plainCause = errorToPOJO(error.cause) as PlainError;
      plain.cause = plainCause;
      if (plainCause?.rootCause) {
        plain.rootCause = `${plain.rootCause}\n👆 ${plainCause.rootCause}`;
      }
    }

    // Include any additional enumerable properties
    Object.getOwnPropertyNames(error).forEach((key) => {
      if (!(key in plain)) {
        Object.assign(plain, { [key]: error[key as keyof Error] });
      }
    });

    return plain as T;
  }
  return error;
}

/** Opinionated logger that extends TagLogger to send any errors logged to PostHog */
class PosthogTagLogger extends TagLogger {
  memories() {
    return [];
  }

  // static emojisStr = `😄 😆 😊 😃 ☺️ 😏 😍 😘 😚 😳 😌 😆 😁 😉 😜 😝 😀 😗 😙 😛 😴 😟 😦 😧 😮 😬 😕 😯 😑 😒 😅 😓 😥 😩 😔 😞 😖 😨 😰 😣 😢 😭 😂 😲 😱 😫 😠 😡 😤 😪 😋 😷 😎 😵 👿 😈 😐 😶 😇 👽 💛 💙 💜 ❤️ 💚 💔 💓 💗 💕 💞 💘 💖 ✨ ⭐ 🌟 💫 💥 💥 💢 ❗ ❓ ❕ ❔ 💤 💨 💦 🎶 🎵 🔥 💩 💩 💩 👍 👍 👎 👎 👌 👊 👊 ✊ ✌️ 👋 ✋ ✋ 👐 ☝️ 👇 👈 👉 🙌 🙏 👆 👏 💪 🤘 🖕 🚶 🏃 🏃 👫 👪 👬 👭 💃 👯 🙆‍♀️ 🙅 💁 🙋 👰‍♀️ 🙇 💏 💑 💆 💇 💅 👦 👧 👩 👨 👶 👵 👴 👲 👳‍♂️ 👷 👮 👼 👸 😺 😸 😻 😽 😼 🙀 😿 😹 😾 👹 👺 🙈 🙉 🙊 💂‍♂️ 💀 🐾 👄 💋 💧 👂 👀 👃 👅 💌 👤 👥 💬 💭☀️ ☔ ☁️ ❄️ ⛄ ⚡ 🌀 🌁 🌊 🐱 🐶 🐭 🐹 🐰 🐺 🐸 🐯 🐨 🐻 🐷 🐽 🐮 🐗 🐵 🐒 🐴 🐎 🐫 🐑 🐘 🐼 🐍 🐦 🐤 🐥 🐣 🐔 🐧 🐢 🐛 🐝 🐜 🪲 🐌 🐙 🐠 🐟 🐳 🐋 🐬 🐄 🐏 🐀 🐃 🐅 🐇 🐉 🐐 🐓 🐕 🐖 🐁 🐂 🐲 🐡 🐊 🐪 🐆 🐈 🐩 🐾 💐 🌸 🌷 🍀 🌹 🌻 🌺 🍁 🍃 🍂 🌿 🍄 🌵 🌴 🌲 🌳 🌰 🌱 🌼 🌾 🐚 🌐 🌞 🌝 🌚 🌑 🌒 🌓 🌔 🌕 🌖 🌗 🌘 🌜 🌛 🌔 🌍 🌎 🌏 🌋 🌌 ⛅ 🎍 💝 🎎 🎒 🎓 🎏 🎆 🎇 🎐 🎑 🎃 👻 🎅 🎄 🎁 🔔 🔕 🎋 🎉 🎊 🎈 🔮 💿 📀 💾 📷 📹 🎥 💻 📺 📱 ☎️ ☎️ 📞 📟 📠 💽 📼 🔉 🔈 🔇 📢 📣 ⌛ ⏳ ⏰ ⌚ 📻 📡 ➿ 🔍 🔎 🔓 🔒 🔏 🔐 🔑 💡 🔦 🔆 🔅 🔌 🔋 📲 📧 📫 📮 🛀 🛁 🚿 🚽 🔧 🔩 🔨 💺 💰 💴 💵 💷 💶 💳 💸 📧 📥 📤 ✉️ 📨 📯 📪 📬 📭 📦 🚪 🚬 💣 🔫 🔪 💊 💉 📄 📃 📑 📊 📈 📉 📜 📋 📆 📅 📇 📁 📂 ✂️ 📌 📎 ✒️ ✏️ 📏 📐 📕 📗 📘 📙 📓 📔 📒 📚 🔖 📛 🔬 🔭 📰 🏈 🏀 ⚽ ⚾ 🎾 🎱 🏉 🎳 ⛳ 🚵 🚴 🏇 🏂 🏊 🏄 🎿 ♠️ ♥️ ♣️ ♦️ 💎 💍 🏆 🎼 🎹 🎻 👾 🎮 🃏 🎴 🎲 🎯 🀄 🎬 📝 📝 📖 🎨 🎤 🎧 🎺 🎷 🎸 👞 👡 👠 💄 👢 👕 👕 👔 👚 👗 🎽 👖 👘 👙 🎀 🎩 👑 👒 👞 🌂 💼 👜 👝 👛 👓 🎣 ☕ 🍵 🍶 🍼 🍺 🍻 🍸 🍹 🍷 🍴 🍕 🍔 🍟 🍗 🍖 🍝 🍛 🍤 🍱 🍣 🍥 🍙 🍘 🍚 🍜 🍲 🍢 🍡 🥚 🍞 🍩 🍮 🍦 🍨 🍧 🎂 🍰 🍪 🍫 🍬 🍭 🍯 🍎 🍏 🍊 🍋 🍒 🍇 🍉 🍓 🍑 🍈 🍌 🍐 🍍 🍠 🍆 🍅 🌽 🏠 🏡 🏫 🏢 🏣 🏥 🏦 🏪 🏩 🏨 💒 ⛪ 🏬 🏤 🌇 🌆 🏯 🏰 ⛺ 🏭 🗼 🗾 🗻 🌄 🌅 🌠 🗽 🌉 🎠 🌈 🎡 ⛲ 🎢 🚢 🚤 ⛵ ⛵ 🚣 ⚓ 🚀 ✈️ 🚁 🚂 🚊 🚞 🚲 🚡 🚟 🚠 🚜 🚙 🚘 🚗 🚗 🚕 🚖 🚛 🚌 🚍 🚨 🚓 🚔 🚒 🚑 🚐 🚚 🚋 🚉 🚆 🚅 🚄 🚈 🚝 🚃 🚎 🎫 ⛽ 🚦 🚥 ⚠️ 🚧 🔰 🏧 🎰 🚏 💈 ♨️ 🏁 🎌 🏮 🗿 🎪 🎭 📍 🚩 🇯🇵 🇰🇷 🇨🇳 🇺🇸 🇫🇷 🇪🇸 🇮🇹 🇷🇺 🇬🇧 🇬🇧 🇩🇪`;
  // static emojis = PosthogTagLogger.emojisStr.split(" ");
  // nickname() {
  //   return Array.from({ length: 3 })
  //     .map(() => {
  //       return PosthogTagLogger.emojis[Math.floor(Math.random() * PosthogTagLogger.emojis.length)];
  //     })
  //     .join("\u200B"); // zero-width space
  // }

  error(...args: [Error] | [string, unknown?]) {
    super.error(...(args as Parameters<TagLogger["error"]>));
    waitUntil(
      Promise.resolve().then(async () => {
        const { PostHog } = await import("posthog-node");
        const { env } = await import("../env.ts");
        if (!env.POSTHOG_PUBLIC_KEY) return;

        try {
          const error = args[0] instanceof Error ? args[0] : new Error(args[0], { cause: args[1] });
          const posthog = new PostHog(env.POSTHOG_PUBLIC_KEY, { host: "https://eu.i.posthog.com" });

          posthog.captureException(error, this.getTag("userId") || "anonymous", {
            environment: env.POSTHOG_ENVIRONMENT,
            ...this.tags,
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
  const mode = import.meta.env?.MODE;
  if (mode === "test") {
    return new TagLogger(() => {}); // don't log in test. note that logs can still be tracked even at the top level by setting the `defaultStore`
  }
  if (mode === "development") {
    // we don't currently have import.meta.env?.MODE for dev 🤷 - but we only want to use the vanilla console logger if we're definitely in a dev environment
    return new PosthogTagLogger(TagLogger.consoleLogFn(console));
  }

  return new PosthogTagLogger(function prodLog({ level, args }) {
    const toLog = {
      // let's make a special case for the first argument, which will very often be a string, to avoid having to search for `args[0]` in the dashboard all the time
      ...(typeof args[0] === "string" ? { message: args[0] } : {}),
      level,
      metadata: { ...this.tags },
      // raw args
      args,
      // Same info as `level` but useful for filtering by `levelNumber >= 2` (warn or worse) in dashboards
      levelNumber: TagLogger.levels[level],
    };
    // for now let's use console.info always. But we could do `console[level](...)`, not sure if that'll work as well in Cloudflare/AWS CloudWatch/etc.
    // eslint-disable-next-line no-console -- only usage
    console.info(JSON.stringify(toLog, (_, value) => errorToPOJO(value)));
  });
}

// #endregion: utils

export const logger = getLogger();
