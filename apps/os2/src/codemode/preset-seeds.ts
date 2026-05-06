import type { EventInput } from "@iterate-com/shared/streams/types";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";

export type CodemodePresetSeed = {
  name: string;
  description: string;
  events: EventInput[];
};

export function createCodemodePresetSeeds(): CodemodePresetSeed[] {
  const petstore: ToolProviderRegistration = {
    instructions:
      "Swagger Petstore OpenAPI reference material. Runtime API execution is intentionally event-based and not wired by this preset.",
    invocation: { kind: "event" },
    path: ["petstore"],
  };
  const apisGuru: ToolProviderRegistration = {
    instructions:
      "APIs.guru OpenAPI reference material. Runtime API execution is intentionally event-based and not wired by this preset.",
    invocation: { kind: "event" },
    path: ["apis"],
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

function toolProviderRegisteredEvent(provider: ToolProviderRegistration): EventInput {
  return {
    type: "events.iterate.com/codemode/tool-provider-registered",
    idempotencyKey: `seed:tool-provider:${provider.path.join("/")}`,
    payload: provider,
  };
}
