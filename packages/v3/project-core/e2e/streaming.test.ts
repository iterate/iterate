import assert from "node:assert/strict";
import { test } from "node:test";
import type { Scope } from "../src/types.ts";
import { base, browserHeaders, project, session, setting, timeout } from "./support.ts";

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test(
  "streams a policy-selected dynamic worker response before a public append releases its tail",
  { skip: !base, timeout },
  async () => {
    const id = project("streaming");
    using context = session<Scope>(id);
    const app = `export default { async fetch(_request, env) {
      const scope = await env.ITX.get();
      const bytes = new TextEncoder();
      let phase = 0;
      const body = new ReadableStream({ async pull(controller) {
        if (phase++ === 0) {
          controller.enqueue(bytes.encode("first"));
          return;
        }
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const page = await scope.readEvents({});
          if (page.events.some(event => event.id === "release")) {
            controller.enqueue(bytes.encode("second"));
            controller.close();
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        controller.error(new Error("stream release event did not arrive"));
      } });
      return new Response(body, { status: 201, statusText: "Rendezvous", headers: {
        "x-streaming-guard": "yes"
      } });
    } };`;
    await context.append(
      setting("policy", "mount/fetch", {
        kind: "worker",
        source: {
          modules: {
            "main.js": `export default { async fetch(request, env) {
              const target = await env.NEXT.to({ kind: "worker", source: {
                modules: { "main.js": ${JSON.stringify(app)} }
              } });
              return target.fetch(request);
            } };`,
          },
        },
      }),
    );
    const response = await within(
      fetch(new URL(`/p/${id}/streaming`, base), {
        headers: { ...browserHeaders, "accept-encoding": "identity" },
      }),
      "first response did not arrive before release",
    );
    if (response.status !== 201) assert.fail(await response.text());
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-streaming-guard"), "yes");
    const reader = response.body!.getReader();
    try {
      const first = await within(
        reader.read(),
        "first response chunk did not arrive before release",
      );
      assert.equal(new TextDecoder().decode(first.value), "first");
      assert.equal(first.done, false);
      await context.append({ id: "release", type: "test.release", data: {} });
      const second = await within(
        reader.read(),
        "second response chunk did not arrive after release",
      );
      assert.equal(new TextDecoder().decode(second.value), "second");
      assert.equal(second.done, false);
      assert.equal(
        (await within(reader.read(), "response did not finish after release")).done,
        true,
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  },
);
