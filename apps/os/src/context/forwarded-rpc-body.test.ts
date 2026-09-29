// forwarded-rpc-body.test.ts — THE PIN of a Cloudflare fault: a Durable Object that forwards, by
// native fetch, a Request it received over Workers RPC with a body of known length logs an uncaught
// "ReadableStream received over RPC disconnected prematurely." after the upstream read every byte
// and answered. No caller sees a failure: it is a false log line. The platform meets it on a repo's
// pull or push from another context: the repo facet sends each git request through its caller's
// egress callback (library.ts), and the root forwards it with `cd`'s terminal fetch (built-ins.ts).
// The prd fault alarm pages nothing for the line on IterateContextDurableObject
// (scripts/ci/prd-fault-alarm.ts `PINNED_LINES`).
//
// workerd io/external-pusher.c++: `ExplicitEndInputPipeAdapter::tryRead` marks a known-length body
// ended once its last byte is read; `pumpTo` hands the read to the inner pipe without that
// bookkeeping, so the fetch pump's read at the end finds the stream not ended and throws. The same
// family: https://github.com/cloudflare/workerd/issues/7277.
//
// Once Cloudflare fixes the fault this row passes and goes red: keep its body as a plain row, and
// delete the line's entry from PINNED_LINES.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { bareWorkerd } from "./bare-workerd-test-support.ts";

/** The pull's shape without the platform: the stateless worker sends three git-sized POSTs over
 *  Workers RPC to the `Root` Durable Object, which forwards each to `/upstream`. The upstream reads
 *  the whole body and answers its length, chunked, as GitHub's git-upload-pack does. */
const FIXTURE = `
import { DurableObject } from "cloudflare:workers";

export class Root extends DurableObject {
  forward(request) {
    return this.env.UPSTREAM.fetch(request);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/upstream") {
      const got = (await request.arrayBuffer()).byteLength;
      const { readable, writable } = new TransformStream();
      (async () => {
        const writer = writable.getWriter();
        for (let chunk = 0; chunk < 4; chunk++) {
          await writer.write(new TextEncoder().encode(chunk ? "." : String(got)));
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await writer.close();
      })();
      return new Response(readable);
    }
    if (pathname !== "/pull") return new Response("up");
    const root = env.ROOT.getByName("root");
    const answers = [];
    for (const size of [68, 151, 114]) {
      const body = new Uint8Array(size);
      const response = await root.forward(new Request("http://upstream/upstream", { method: "POST", body }));
      answers.push(await response.text());
    }
    return new Response(answers.join(" "));
  },
};
`;

createFailing(test, /ReadableStream received over RPC disconnected prematurely/)(
  "workerd: a Durable Object that forwards a Request it received over RPC logs no error once the upstream read every byte",
  async () => {
    await using runtime = await bareWorkerd({
      fixture: FIXTURE,
      resolveDir: dirname(fileURLToPath(import.meta.url)),
      worker: `bindings = [ (name = "UPSTREAM", service = "main"), (name = "ROOT", durableObjectNamespace = "Root") ],
    durableObjectNamespaces = [ (className = "Root", uniqueKey = "root") ],
    durableObjectStorage = (inMemory = void),`,
    });
    // Every byte arrived and every answer came back whole.
    expect(await (await fetch(`${runtime.http}/pull`)).text()).toBe("68... 151... 114...");
    const disconnected = (await runtime.settledLog()).filter((line) =>
      line.includes("disconnected prematurely"),
    );
    if (disconnected.length)
      throw new Error(`the Root logged ${disconnected.length}: ${disconnected[0]}`);
  },
);
