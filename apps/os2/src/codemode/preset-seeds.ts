import type { EventInput } from "@iterate-com/events-contract";
import type { ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";
import { createOpenApiProvider } from "~/rpc-targets/openapi-bridge.ts";

export type CodemodePresetSeed = {
  name: string;
  description: string;
  events: EventInput[];
};

export function createCodemodePresetSeeds(input: {
  workerScriptName: string;
}): CodemodePresetSeed[] {
  const petstore = createOpenApiProvider({
    path: ["petstore"],
    workerScriptName: input.workerScriptName,
    specUrl: "https://petstore.swagger.io/v2/swagger.json",
    baseUrl: "https://petstore.swagger.io/v2",
  });
  const apisGuru = createOpenApiProvider({
    path: ["apis"],
    workerScriptName: input.workerScriptName,
    specUrl: "https://api.apis.guru/v2/specs/apis.guru/2.2.0/openapi.json",
    baseUrl: "https://api.apis.guru/v2",
  });

  return [
    {
      name: "Public APIs",
      description: "Petstore and APIs.guru OpenAPI providers for codemode experiments.",
      events: [toolProviderRegisteredEvent(petstore), toolProviderRegisteredEvent(apisGuru)],
    },
    {
      name: "Petstore only",
      description: "Swagger Petstore as a small public OpenAPI tool provider.",
      events: [toolProviderRegisteredEvent(petstore)],
    },
  ];
}

function toolProviderRegisteredEvent(provider: ToolProviderDescriptor): EventInput {
  return {
    type: "events.iterate.com/codemode/tool-provider-registered",
    idempotencyKey: `seed:tool-provider:${provider.path.join("/")}`,
    payload: {
      descriptor: provider,
      path: provider.path,
    },
  };
}
