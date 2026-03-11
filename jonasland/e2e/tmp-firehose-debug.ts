import { randomUUID } from "node:crypto";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";

async function main(): Promise<void> {
  const image = process.env.JONASLAND_SANDBOX_IMAGE ?? process.env.E2E_DOCKER_IMAGE_REF ?? "";
  if (!image) throw new Error("missing image");

  await using deployment = await DockerDeployment.create({
    image: image,
    slug: `tmp-firehose-${randomUUID().slice(0, 8)}`,
  });
  await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000) });

  const type = "https://events.iterate.com/events/test/firehose-debug";
  const marker = randomUUID();
  const path = `/jonasland/e2e/firehose-debug/${randomUUID()}`;

  const iterator = await deployment.eventsService.firehose({});
  await deployment.eventsService.append({
    path,
    events: [{ type, payload: { marker } }],
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<unknown>>((resolve) =>
        setTimeout(() => resolve({ done: false, value: "__timeout__" }), 2_000),
      ),
    ]);
    if (result.done) {
      console.log("[firehose-debug] iterator done");
      break;
    }
    console.log("[firehose-debug] event:", JSON.stringify(result.value));
    if (typeof result.value === "object" && result.value !== null) {
      const event = result.value as Record<string, unknown>;
      const payload = event.payload as Record<string, unknown> | undefined;
      if (event.type === type && payload?.marker === marker) {
        console.log("[firehose-debug] matched marker");
        return;
      }
    }
  }

  throw new Error("did not see appended event in firehose");
}

void main();
