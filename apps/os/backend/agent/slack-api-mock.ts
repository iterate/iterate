import type { WebClient } from "@slack/web-api";
import jsonata from "jsonata/sync";

export type SlackAPIMockOptions = {
  log: (message: string) => void;
};

export type SlackAPIMock = ReturnType<typeof createSlackAPIMock>;

/**
 * Creates a mocked version of the Slack API. Features:
 * - deeply mock sub-structres so you can do `slack.chat.postMessage(...)` and `slack.assistant.threads.setStatus(...)`
 * - records all calls in an array
 * - allows mocking the return value of a call based on a jsonata expression
 * - logs calls to a `log` function you pass in
 *
 * in theory you could make this a general-purpose mocking tool but for now it's slack-only
 */
export const createSlackAPIMock = (options?: Partial<SlackAPIMockOptions>) => {
  const calls: Array<{ path: string[]; args: unknown[]; time: Date }> = [];

  const matchers: Array<{ expression: string; value: unknown }> = [
    { expression: "true", value: { ok: true } }, // default - just return {ok: true}
  ];

  /**
   * a jsonata expression and a value - any call matching the expression will return this value
   * the expression will be evaluated against an object looking like:
   *
   * ```js
   * type CallInfo = {
   *   path: string;
   *   args: any[];
   *   time: string; // ISO date string
   * }
   *
   * const exampleCallInfo: CallInfo = {
   *   path: "chat.postMessage",
   *   args: [{ text: "Hello, world!", thread_ts: "1234567890", channel: "C08R1SMTZGD" }],
   *   time: new Date().toISOString(),
   * }
   * ```
   */
  const mockReturnValue = (expression: string, value: unknown) => {
    matchers.push({ expression, value });
  };

  const props = { calls, mockReturnValue };
  return mockSlack([], {
    props,
    call: (path, args) => {
      const time = new Date();
      calls.push({ path, args, time });
      const message = `${path.join(".")}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;
      options?.log?.(message);
      const callInfo = { path: path.join("."), args, time: time.toISOString() };
      const matcher = matchers.findLast((matcher) =>
        jsonata(matcher.expression).evaluate(callInfo),
      );
      return matcher?.value;
    },
  }) as WebClient & Partial<typeof props>;
};

const mockSlack = (
  path: string[],
  options: {
    props: Record<string, unknown>;
    call: (path: string[], args: unknown[]) => unknown;
  },
) => {
  return new Proxy<any>(() => {}, {
    get: (_target, prop) => {
      if (typeof prop === "string" && prop in options.props) {
        return options.props[prop];
      }
      return mockSlack(path.concat(String(prop)), options);
    },
    apply: (_target, _this, args) => {
      return Promise.resolve(options.call(path, args));
    },
  });
};
