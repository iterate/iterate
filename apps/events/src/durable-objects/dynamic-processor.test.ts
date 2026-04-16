import type { DynamicWorkerConfig } from "@iterate-com/events-contract";
import { describe, expect, test } from "vitest";
import {
  buildDynamicWorkerLoaderCode,
  buildDynamicWorkerLoaderKey,
  resolveDynamicWorkerCompatibilityFlags,
  resolveDynamicWorkerOutboundGateway,
} from "./dynamic-processor.ts";
import { dynamicWorkerProjectSlugHeader } from "~/lib/dynamic-worker-egress.ts";

const baseConfig: DynamicWorkerConfig = {
  compatibilityDate: "2026-02-05",
  compatibilityFlags: [],
  mainModule: "worker.js",
  modules: {
    "worker.js": "export default { async run() {} };",
  },
};

describe("resolveDynamicWorkerCompatibilityFlags", () => {
  test("defaults dynamic workers to node compatibility and process.env", () => {
    expect(resolveDynamicWorkerCompatibilityFlags([])).toEqual([
      "nodejs_compat",
      "nodejs_compat_populate_process_env",
    ]);
  });

  test("preserves custom flags while adding dynamic worker defaults", () => {
    expect(resolveDynamicWorkerCompatibilityFlags(["rpc_params_dup_stubs"])).toEqual([
      "rpc_params_dup_stubs",
      "nodejs_compat",
      "nodejs_compat_populate_process_env",
    ]);
  });

  test("respects explicit process.env opt-out", () => {
    expect(
      resolveDynamicWorkerCompatibilityFlags(["nodejs_compat_do_not_populate_process_env"]),
    ).toEqual(["nodejs_compat_do_not_populate_process_env", "nodejs_compat"]);
  });
});

describe("buildDynamicWorkerLoaderCode", () => {
  test("passes through an explicit outbound gateway binding", () => {
    const globalOutbound = {} as Fetcher;
    const loaderCode = buildDynamicWorkerLoaderCode({
      config: baseConfig,
      env: undefined,
      globalOutbound,
      projectSlug: "public",
    });

    expect(loaderCode.globalOutbound).toBe(globalOutbound);
  });

  test("injects project slug into the runtime config module", () => {
    const loaderCode = buildDynamicWorkerLoaderCode({
      config: baseConfig,
      env: undefined,
      globalOutbound: undefined,
      projectSlug: "team-a",
    });

    expect(parseRuntimeConfigModule(loaderCode.modules["runtime-config.js"])).toMatchObject({
      projectSlug: "team-a",
    });
  });

  test("overwrites worker.js with the latest runtime wrapper", () => {
    const loaderCode = buildDynamicWorkerLoaderCode({
      config: {
        ...baseConfig,
        modules: {
          "worker.js": "export default { async run() {} };",
        },
      },
      env: undefined,
      globalOutbound: undefined,
      projectSlug: "team-a",
    });

    expect(loaderCode.modules["worker.js"]).toContain(dynamicWorkerProjectSlugHeader);
    expect(loaderCode.modules["worker.js"]).toContain(
      'import runtimeConfig from "./runtime-config.js";',
    );
  });
});

describe("buildDynamicWorkerLoaderKey", () => {
  test("includes the project slug in the worker cache key", () => {
    expect(
      buildDynamicWorkerLoaderKey({
        configKey: '{"config":{},"envVarsByKey":{}}',
        path: "/streams/demo",
        projectSlug: "team-a",
        slug: "worker",
      }),
    ).toContain("dynamic-worker:team-a:/streams/demo:worker:");
  });
});

describe("resolveDynamicWorkerOutboundGateway", () => {
  test("defaults to the dynamic worker egress gateway", () => {
    expect(resolveDynamicWorkerOutboundGateway(undefined)).toEqual({
      entrypoint: "DynamicWorkerEgressGateway",
    });
  });

  test("preserves an explicit gateway config", () => {
    expect(
      resolveDynamicWorkerOutboundGateway({
        entrypoint: "DynamicWorkerEgressGateway",
        props: {
          secretHeaderName: "authorization",
          secretHeaderValue: "Bearer test",
        },
      }),
    ).toEqual({
      entrypoint: "DynamicWorkerEgressGateway",
      props: {
        secretHeaderName: "authorization",
        secretHeaderValue: "Bearer test",
      },
    });
  });
});

function parseRuntimeConfigModule(moduleText: string) {
  return JSON.parse(moduleText.replace(/^export default /, "").replace(/;$/, ""));
}
