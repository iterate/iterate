import type { EventInput } from "@iterate-com/events-contract";
import type { ToolProviderDocumentation } from "@iterate-com/shared/stream-processors/codemode/contract";

export type CodemodePresetSeed = {
  name: string;
  description: string;
  events: EventInput[];
};

export function createCodemodePresetSeeds(_input: {
  workerScriptName: string;
}): CodemodePresetSeed[] {
  const petstore: ToolProviderDocumentation = {
    docs: "Swagger Petstore OpenAPI documentation. This preset is model-visible context only in the current codemode event model.",
    path: ["petstore"],
    instructions:
      "Use this as reference material; runtime API execution is not wired by this preset.",
    typeDefinitions: "declare const petstore: unknown;",
  };
  const apisGuru: ToolProviderDocumentation = {
    docs: "APIs.guru OpenAPI documentation. This preset is model-visible context only in the current codemode event model.",
    path: ["apis"],
    instructions:
      "Use this as reference material; runtime API execution is not wired by this preset.",
    typeDefinitions: "declare const apis: unknown;",
  };

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

function toolProviderRegisteredEvent(provider: ToolProviderDocumentation): EventInput {
  return {
    type: "events.iterate.com/codemode/tool-provider-registered",
    idempotencyKey: `seed:tool-provider:${provider.path.join("/")}`,
    payload: provider,
  };
}
