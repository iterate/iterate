import { dispatchCallableFetch, validateCallable } from "@iterate-com/shared/callable/runtime.ts";
import type { FetchCallable } from "@iterate-com/shared/callable/types.ts";
import type { ExactHostIngressRule, IngressMatch } from "./types.ts";
import {
  ingressHostnameFromRequest,
  ingressUrlFromRequest,
  normalizeIngressHost,
  withIngressHeaders,
} from "./host-headers.ts";

export { ingressHostnameFromRequest, ingressUrlFromRequest, normalizeIngressHost };

type LookupIngressRule = (
  host: string,
) => ExactHostIngressRule | Promise<ExactHostIngressRule | null> | null;

type DispatchContext = {
  env?: Record<string, unknown>;
  exports?: Record<string, unknown>;
};

export async function matchIngressRequest(input: {
  request: Request;
  lookupRule: LookupIngressRule;
}): Promise<IngressMatch | null> {
  const requestHost = normalizeIngressHost(ingressHostnameFromRequest(input.request));
  const rule = await input.lookupRule(requestHost);
  return rule ? { requestHost, rule } : null;
}

export async function dispatchFetchCallable(input: {
  callable: FetchCallable;
  context: DispatchContext;
  request: Request;
}): Promise<Response> {
  return await dispatchCallableFetch({
    callable: input.callable,
    ctx: {
      env: input.context.env,
      exports: input.context.exports,
      fetch: globalThis.fetch,
    },
    request: withIngressHeaders(input.request),
  });
}

export function parseIngressCallable(value: string): FetchCallable {
  const callable = validateCallable({ callable: JSON.parse(value) as unknown });
  if (callable.type !== "fetch") throw new Error("Invalid ingress fetch callable");
  return callable;
}
