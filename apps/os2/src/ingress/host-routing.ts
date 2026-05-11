import { dispatchCallableFetch, validateCallable } from "@iterate-com/shared/callable/runtime.ts";
import type { FetchCallable } from "@iterate-com/shared/callable/types.ts";
import type { ExactHostIngressRule, IngressMatch } from "./types.ts";

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
  fallbackRules?: readonly ExactHostIngressRule[];
}): Promise<IngressMatch | null> {
  const requestHost = normalizeIngressHost(new URL(input.request.url).hostname);
  const directRule = await input.lookupRule(requestHost);
  if (directRule) return { requestHost, rule: directRule };

  const fallbackRule = [...(input.fallbackRules ?? [])]
    .filter((rule) => rule.host === "*")
    .sort((left, right) => right.priority - left.priority)[0];

  return fallbackRule ? { requestHost, rule: fallbackRule } : null;
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

export function normalizeIngressHost(host: string) {
  return host.trim().replace(/\.$/, "").toLowerCase();
}

export function parseIngressCallable(value: string): FetchCallable {
  const callable = validateCallable({ callable: JSON.parse(value) as unknown });
  if (callable.type !== "fetch") throw new Error("Invalid ingress fetch callable");
  return callable;
}

export function ingressHostnameFromRequest(request: Request) {
  return (
    request.headers.get("x-iterate-ingress-hostname") ??
    request.headers.get("x-forwarded-host")?.replace(/:\d+$/, "") ??
    new URL(request.url).hostname
  );
}

export function ingressUrlFromRequest(request: Request) {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedHost) url.host = forwardedHost;
  if (forwardedProto) url.protocol = `${forwardedProto.replace(/:$/, "")}:`;
  return url;
}

function withIngressHeaders(request: Request) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (!headers.has("x-iterate-ingress-hostname")) {
    headers.set("x-iterate-ingress-hostname", url.hostname);
  }
  if (!headers.has("x-forwarded-host")) {
    headers.set("x-forwarded-host", url.host);
  }
  if (!headers.has("x-forwarded-proto")) {
    headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));
  }
  return new Request(request, { headers });
}
