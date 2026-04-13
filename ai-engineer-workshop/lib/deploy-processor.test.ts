// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildConfiguredEventFromProcessorFile,
  parseEventJson,
  resolveProcessorExport,
} from "./deploy-processor.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("deploy processor helpers", () => {
  test("resolves the only processor-like named export", async () => {
    const directory = await createTempDirectory();
    const file = join(directory, "processor.mjs");

    await writeFile(
      file,
      [
        "export const notAProcessor = { slug: 42 };",
        'export const agentProcessor = { slug: "agent", initialState: { count: 0 } };',
        "",
      ].join("\n"),
    );

    const resolved = await resolveProcessorExport({ file });

    expect(resolved.exportName).toBe("agentProcessor");
    expect(resolved.processor.slug).toBe("agent");
  });

  test("accepts a processor export without initialState", async () => {
    const directory = await createTempDirectory();
    const file = join(directory, "processor.mjs");

    await writeFile(
      file,
      ['export const bashmodeProcessor = { slug: "bashmode", afterAppend() {} };', ""].join("\n"),
    );

    const resolved = await resolveProcessorExport({
      file,
      preferredExportName: "bashmodeProcessor",
    });

    expect(resolved.exportName).toBe("bashmodeProcessor");
    expect(resolved.processor.slug).toBe("bashmode");
  });

  test("requires an explicit export when multiple processors are exported", async () => {
    const directory = await createTempDirectory();
    const file = join(directory, "processor.mjs");

    await writeFile(
      file,
      [
        'export const alpha = { slug: "alpha", initialState: {} };',
        'export const beta = { slug: "beta", initialState: {} };',
        "",
      ].join("\n"),
    );

    await expect(resolveProcessorExport({ file })).rejects.toThrow(
      /Multiple processor exports found/,
    );
  });

  test("bundles a named processor export into a configured event", async () => {
    const directory = await createTempDirectory();
    const file = join(directory, "processor.mjs");

    await writeFile(
      file,
      `
import { defineProcessor } from "ai-engineer-workshop/runtime";

export const agentProcessor = defineProcessor(() => ({
  slug: "agent",
  initialState: { seen: 0 },
  reduce({ state, event }) {
    if (event.type !== "ping") {
      return state;
    }

    return { seen: state.seen + 1 };
  },
  async afterAppend({ append, event, state }) {
    if (event.type !== "ping") {
      return;
    }

    await append({
      event: {
        type: "pong",
        payload: { seen: state.seen },
      },
    });
  },
}));
      `.trim(),
    );

    const configuredEvent = await buildConfiguredEventFromProcessorFile({
      file,
      outboundGateway: true,
      processorExportName: "agentProcessor",
      slug: "named-agent",
    });

    expect(configuredEvent.payload.slug).toBe("named-agent");
    expect(configuredEvent.payload.outboundGateway).toEqual({
      entrypoint: "DynamicWorkerEgressGateway",
    });
    expect(configuredEvent.payload.script).toContain('type: "pong"');
    expect(configuredEvent.payload.script).not.toContain('from "ai-engineer-workshop"');
  });

  test("parses seed events from JSON", () => {
    expect(
      parseEventJson(JSON.stringify({ type: "agent-input-added", payload: { content: "hello" } })),
    ).toEqual({
      type: "agent-input-added",
      payload: { content: "hello" },
    });
  });
});

async function createTempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ai-engineer-workshop-deploy-processor-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
