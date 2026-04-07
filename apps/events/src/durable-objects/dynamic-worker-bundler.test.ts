import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDynamicWorkerConfiguredEvent, slugFromEntryFile } from "./dynamic-worker-bundler.ts";

describe("dynamic worker bundler", () => {
  test("defaults the slug from the processor filename", () => {
    expect(slugFromEntryFile("/tmp/simple-openai-loop.ts")).toBe("simple-openai-loop");
  });

  test("bundles a current workshop-style processor into a configured event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dynamic-worker-bundler-"));
    const entryFile = join(directory, "current-processor.ts");

    await writeFile(
      entryFile,
      `
import { defineProcessor } from "ai-engineer-workshop";

export default defineProcessor({
  initialState: { count: 0 },
  reduce: (state, event) => {
    if (event.type !== "ping") {
      return state;
    }

    return { count: state.count + 1 };
  },
  onEvent: async ({ append, event, state }) => {
    if (event.type !== "ping") {
      return;
    }

    await append({
      type: "pong",
      payload: { count: state.count },
    });
  },
});
      `.trim(),
    );

    try {
      const configuredEvent = await buildDynamicWorkerConfiguredEvent({
        entryFile,
      });

      expect(configuredEvent.payload.slug).toBe("current-processor");
      expect(configuredEvent.payload.script).toContain('type: "pong"');
      expect(configuredEvent.payload.script).not.toContain('from "ai-engineer-workshop"');
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
  initialState: { count: 0 },
  reduce(state, event) {
    if (event.type !== "ping") {
      return state;
    }

    return { count: state.count + 1 };
  },
  async onEvent({ append, event, state }) {
    if (event.type !== "ping") {
      return;
    }

    await append({
      type: "pong",
      payload: { count: state.count },
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
      expect(configuredEvent.payload.script).toContain('type: "pong"');
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
  initialState: {},
  reduce(state) {
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

  test("embeds a runtime guard for the legacy processor shape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dynamic-worker-bundler-"));
    const entryFile = join(directory, "legacy-processor.ts");

    await writeFile(
      entryFile,
      `
export default {
  slug: "legacy-processor",
  initialState: {},
  reduce: ({ state }) => state,
  async afterAppend() {},
};
      `.trim(),
    );

    try {
      const configuredEvent = await buildDynamicWorkerConfiguredEvent({
        entryFile,
      });

      expect(configuredEvent.payload.script).toContain(
        "Legacy processor shape with afterAppend() is not supported.",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
