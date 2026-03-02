import type { SharedOptions } from "msw";
import type { RequestHandler } from "msw";
import type { Har } from "../har-types.ts";

export type MockMswHttpProxyMode = "record" | "replay" | "replay-or-record";

export type MockMswHttpProxyRequestRewriteInput = {
  method: string;
  url: string;
  headers: Record<string, string>;
};

export type MockMswHttpProxyRequestRewriteResult = {
  url?: string;
  headers?: Record<string, string | undefined>;
};

export type MockMswHttpProxyRequestRewrite = (
  input: MockMswHttpProxyRequestRewriteInput,
) => MockMswHttpProxyRequestRewriteResult | void;

export type MockMswHttpProxyReplaySource = Har | string;

export interface MockMswHttpProxyListenOptions {
  mode?: MockMswHttpProxyMode;
  replayFromHar?: MockMswHttpProxyReplaySource;
  harRecordingPath?: string;
  handlers?: RequestHandler[];
  rewriteRequest?: MockMswHttpProxyRequestRewrite;
  onUnhandledRequest?: SharedOptions["onUnhandledRequest"];
  host?: string;
  port?: number;
}
