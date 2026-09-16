import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

for (const scenario of ["shared-concurrent", "isolated-concurrent", "shared-sequential"]) {
  test(scenario, async ({ request }) => {
    const { key, url } = JSON.parse(
      await readFile(new URL("credentials.ignoreme.json", import.meta.url), "utf8"),
    );
    const group = randomBytes(8).toString("hex");
    const calls = Array.from({ length: 8 }, (_, index) => ({
      index,
      traceparent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
      object: scenario === "isolated-concurrent" ? `${group}-${index}` : group,
    }));
    const send = async (call: (typeof calls)[number]) => {
      const result = await request.get(`${url}/?object=${call.object}`, {
        headers: { "x-probe-key": key, traceparent: call.traceparent },
      });
      expect(await result.json()).toMatchObject({ ok: true, traceparent: call.traceparent });
    };
    if (scenario === "shared-sequential") {
      for (const call of calls) await send(call);
    } else {
      await Promise.all(calls.map(send));
    }
    await writeFile(
      new URL(`evidence/${scenario}.json`, import.meta.url),
      JSON.stringify(calls, null, 2),
    );
  });
}
