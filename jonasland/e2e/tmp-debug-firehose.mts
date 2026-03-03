import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment";
import { useDockerPublicIngress } from "./test-helpers/use-docker-public-ingress.ts";

const image =
  process.env.JONASLAND_E2E_DOCKER_IMAGE ??
  "registry.fly.io/iterate-sandbox:jonasland-sha-bdc22c4-dirty";
const dep = await DockerDeployment.createWithConfig({ dockerImage: image }).create({
  name: `debug-firehose-${Math.random().toString(36).slice(2, 8)}`,
});
await using fix = await useDockerPublicIngress({ deployment: dep, testSlug: "debug-firehose" });
console.log("ingress", fix.ingressBaseUrl);
for (const path of [
  "/healthz",
  "/__iterate/events/healthz",
  "/__iterate/events/orpc",
  "/__iterate/events/orpc/firehose",
]) {
  const isFirehose = path.endsWith("/firehose");
  const method = isFirehose ? "POST" : "GET";
  const body = isFirehose ? JSON.stringify({ json: {} }) : undefined;
  const headers = isFirehose ? { "content-type": "application/json" } : undefined;
  const res = await fetch(new URL(path, fix.ingressBaseUrl), { method, body, headers });
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
