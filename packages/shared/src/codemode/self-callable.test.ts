import { describe, expect, it } from "vitest";
import { createSelfToolProviderDescriptor, selfToolProviderBindingName } from "./self-callable.ts";
import { ToolProviderDescriptor } from "./types.ts";

describe("selfToolProviderBindingName", () => {
  it("derives a stable binding name from worker script and entrypoint", () => {
    expect(
      selfToolProviderBindingName({
        workerScriptName: "os2-jonas-dev",
        entrypoint: "OpenApiBridge",
      }),
    ).toBe("SELF_TOOL_PROVIDER_OS2_JONAS_DEV_OPENAPIBRIDGE");
  });
});

describe("createSelfToolProviderDescriptor", () => {
  it("creates a storable env service descriptor for a named app entrypoint", () => {
    const descriptor = createSelfToolProviderDescriptor({
      path: ["petstore"],
      workerScriptName: "os2-jonas-dev",
      entrypoint: "OpenApiBridge",
      providerProps: {
        specUrl: "https://petstore.swagger.io/v2/swagger.json",
        baseUrl: "https://petstore.swagger.io/v2",
      },
    });

    expect(ToolProviderDescriptor.parse(descriptor)).toEqual(descriptor);
    expect(descriptor.executeToolFunction).toMatchObject({
      type: "workers-rpc",
      via: {
        type: "env-binding",
        bindingType: "service",
        bindingName: "SELF_TOOL_PROVIDER_OS2_JONAS_DEV_OPENAPIBRIDGE",
      },
      rpcMethod: "executeToolFunction",
      transformInput: {
        shallowMerge: {
          providerProps: {
            specUrl: "https://petstore.swagger.io/v2/swagger.json",
            baseUrl: "https://petstore.swagger.io/v2",
          },
        },
      },
    });
  });

  it("allows deployment code to provide the exact binding name", () => {
    const descriptor = createSelfToolProviderDescriptor({
      path: ["petstore"],
      workerScriptName: "ignored",
      entrypoint: "OpenApiBridge",
      bindingName: "OPEN_API_BRIDGE",
    });

    expect(descriptor.executeToolFunction).toMatchObject({
      via: {
        type: "env-binding",
        bindingType: "service",
        bindingName: "OPEN_API_BRIDGE",
      },
    });
  });
});
