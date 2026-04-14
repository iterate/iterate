// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDynamicWorkerConfiguredEvent, slugFromEntryFile } from "./dynamic-worker-bundler.ts";

describe("dynamic worker bundler", () => {
  test("defaults the slug from the processor filename", () => {
    expect(slugFromEntryFile("/tmp/simple-openai-loop.ts")).toBe("simple-openai-loop");
  });

  test("bundles a processor SDK import into a configured event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dynamic-worker-bundler-"));
    const entryFile = join(directory, "current-processor.ts");
    const processorRuntimePackageName = ["ai", "engineer", "workshop"].join("-");

    await writeFile(
      entryFile,
      `
import { defineProcessor } from ${JSON.stringify(processorRuntimePackageName)};

export default defineProcessor(() => ({
  slug: "workshop-processor",
  initialState: { count: 0 },
  reduce: ({ state, event }) => {
    if (event.type !== "ping") {
      return state;
    }

    return { count: state.count + 1 };
  },
  afterAppend: async ({ append, event, state }) => {
    if (event.type !== "ping") {
      return;
    }

    await append({
      event: {
        type: "pong",
        payload: { count: state.count },
      },
    });
  },
}));
      `.trim(),
    );

    try {
      const configuredEvent = await buildDynamicWorkerConfiguredEvent({
        entryFile,
      });

      expect(configuredEvent.payload.slug).toBe("current-processor");
      expect(configuredEvent.payload.script).toMatch(/type:\s*"pong"/);
      expect(configuredEvent.payload.script).toContain("afterAppend");
      expect(configuredEvent.payload.script).not.toContain("onEvent");
      expect(configuredEvent.payload.script).not.toContain(`from "${processorRuntimePackageName}"`);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("preserves outbound gateway config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dynamic-worker-bundler-"));
    const entryFile = join(directory, "gateway-processor.ts");

    await writeFile(
      entryFile,
      `
export default {
  slug: "gateway-processor",
  initialState: { count: 0 },
  reduce({ state, event }) {
    if (event.type !== "ping") {
      return state;
    }

    return { count: state.count + 1 };
  },
  async afterAppend({ append, event, state }) {
    if (event.type !== "ping") {
      return;
    }

    await append({
      event: {
        type: "pong",
        payload: { count: state.count },
      },
    });
  },
};
      `.trim(),
    );

    try {
      const configuredEvent = await buildDynamicWorkerConfiguredEvent({
        compatibilityFlags: ["rpc_params_dup_stubs"],
        entryFile,
        outboundGateway: {
          entrypoint: "DynamicWorkerEgressGateway",
          props: {
            secretHeaderName: "authorization",
            secretHeaderValue: "Bearer test",
          },
        },
        slug: "current-openai-loop",
      });

      expect(configuredEvent.payload.slug).toBe("current-openai-loop");
      expect(configuredEvent.payload.compatibilityFlags).toEqual(["rpc_params_dup_stubs"]);
      expect(configuredEvent.payload.outboundGateway).toEqual({
        entrypoint: "DynamicWorkerEgressGateway",
        props: {
          secretHeaderName: "authorization",
          secretHeaderValue: "Bearer test",
        },
      });
      expect(configuredEvent.payload.script).toMatch(/type:\s*"pong"/);
      expect(configuredEvent.payload.script).toContain("afterAppend");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("preserves node builtins when nodejs_compat is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dynamic-worker-bundler-"));
    const entryFile = join(directory, "node-compat-processor.ts");

    await writeFile(
      entryFile,
      `
import { gunzipSync } from "node:zlib";

export default {
  slug: "node-compat-processor",
  initialState: {},
  reduce({ state }) {
    gunzipSync(new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 0, 3]));
    return state;
  },
};
      `.trim(),
    );

    try {
      const configuredEvent = await buildDynamicWorkerConfiguredEvent({
        compatibilityFlags: ["nodejs_compat"],
        entryFile,
      });

      expect(configuredEvent.payload.compatibilityFlags).toEqual(["nodejs_compat"]);
      expect(configuredEvent.payload.script).toMatch(/from\s*"node:zlib"/);
      expect(configuredEvent.payload.script).toContain("gunzipSync");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("allows outbound gateway config without injected headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dynamic-worker-bundler-"));
    const entryFile = join(directory, "gateway-only-processor.ts");

    await writeFile(
      entryFile,
      `
export default {
  slug: "gateway-only-processor",
  initialState: {},
  reduce({ state }) {
    return state;
  },
};
      `.trim(),
    );

    try {
      const configuredEvent = await buildDynamicWorkerConfiguredEvent({
        entryFile,
        outboundGateway: {
          entrypoint: "DynamicWorkerEgressGateway",
        },
      });

      expect(configuredEvent.payload.outboundGateway).toEqual({
        entrypoint: "DynamicWorkerEgressGateway",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
