/**
 * Hostname normalization + forwarded-header plumbing for ingress, in its own
 * module so the ingress router worker (and the D1 rule sources) can use it
 * without bundling the callable dispatch runtime — host-routing.ts drags
 * jsonata in via @iterate-com/shared/callable/runtime.
 */

export function normalizeIngressHost(host: string) {
  return host.trim().replace(/\.$/, "").toLowerCase();
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

export function withIngressHeaders(request: Request) {
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
