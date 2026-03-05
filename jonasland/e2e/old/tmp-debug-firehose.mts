import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment";
import {
  allocateLoopbackPort,
  buildIngressPublicBaseUrl,
  resolveIngressProxyConfig,
} from "./test-helpers/public-ingress-config.ts";
import { useCloudflareTunnel } from "./test-helpers/use-cloudflare-tunnel.ts";

const image =
  process.env.JONASLAND_E2E_DOCKER_IMAGE ??
  "registry.fly.io/iterate-sandbox:jonasland-sha-bdc22c4-dirty";
const ingress = resolveIngressProxyConfig();
const ingressHostPort = await allocateLoopbackPort();
await using tunnel = await useCloudflareTunnel({
  localPort: ingressHostPort,
  cloudflaredBin: process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
});
const ingressBaseUrl = buildIngressPublicBaseUrl({
  testSlug: "debug-firehose",
  ingressProxyDomain: ingress.ingressProxyDomain,
});
const dep = await DockerDeployment.createWithOpts({ dockerImage: image }).create({
  name: `debug-firehose-${Math.random().toString(36).slice(2, 8)}`,
  ingressHostPort,
  ingress: {
    publicBaseHost: ingressBaseUrl,
    publicBaseHostType: "prefix",
    createIngressProxyRoutes: true,
    ingressProxyBaseUrl: ingress.ingressProxyBaseUrl,
    ingressProxyApiKey: ingress.ingressProxyApiKey,
    ingressProxyTargetUrl: tunnel.tunnelUrl,
  },
});
console.log("ingress", ingressBaseUrl);
for (const path of [
  "/__iterate/health",
  "/api/__iterate/health",
  "/__iterate/events/orpc",
  "/__iterate/events/orpc/firehose",
]) {
  const isFirehose = path.endsWith("/firehose");
  const method = isFirehose ? "POST" : "GET";
  const body = isFirehose ? JSON.stringify({ json: {} }) : undefined;
  const headers = isFirehose ? { "content-type": "application/json" } : undefined;
  const res = await fetch(new URL(path, ingressBaseUrl), { method, body, headers });
  const text = await res.text();
  console.log(path, res.status, res.headers.get("content-type"), text.slice(0, 280));
}
const stream = await dep.events.firehose({});
console.log(
  "firehose-type",
  typeof stream,
  stream && (stream as any)[Symbol.asyncIterator] ? "iterable" : "not-iterable",
);
await dep[Symbol.asyncDispose]();
