import { WorkerEntrypoint } from "cloudflare:workers";
import { createCodemodeContext } from "@iterate-com/shared/codemode/context-proxy";

export { CodemodeSession } from "./codemode-session.ts";

type ToolFunctionInput = {
  codemodeSessionCapability: Parameters<
    typeof createCodemodeContext
  >[0]["codemodeSessionCapability"];
  path: string[];
  payload: Record<string, unknown>;
};

export class ProviderA extends WorkerEntrypoint {
  async executeToolFunction(input: ToolFunctionInput) {
    const path = input.path.join(".");

    if (path === "compose.exclaimViaB") {
      const ctx = createCodemodeContext({
        codemodeSessionCapability: input.codemodeSessionCapability,
      });
      const result = (await ctx.providerB.text.exclaim({
        value: input.payload.value,
      })) as { value: string };

      return {
        provider: "provider-a",
        route: "codemode-session-capability",
        toolFunction: "compose.exclaimViaB",
        value: result.value,
      };
    }

    if (path === "math.add") {
      return {
        provider: "provider-a",
        toolFunction: "math.add",
        value: Number(input.payload.left) + Number(input.payload.right),
      };
    }

    if (path === "text.upper") {
      return {
        provider: "provider-a",
        toolFunction: "text.upper",
        value: String(input.payload.value).toUpperCase(),
      };
    }

    throw new Error(`Provider A does not implement ${path}`);
  }

  async describeToolFunctions() {
    return {
      typeDefinitions: `{
  compose: {
    exclaimViaB(input: { value: string }): Promise<{ value: string }>;
  };
  math: {
    add(input: { left: number; right: number }): Promise<{ value: number }>;
  };
  text: {
    upper(input: { value: string }): Promise<{ value: string }>;
  };
}`,
    };
  }
}

export class ProviderB extends WorkerEntrypoint {
  async executeToolFunction(input: ToolFunctionInput) {
    const path = input.path.join(".");

    if (path === "compose.addThenUpper") {
      const ctx = createCodemodeContext({
        codemodeSessionCapability: input.codemodeSessionCapability,
      });
      const added = (await ctx.providerA.math.add({
        left: input.payload.left,
        right: input.payload.right,
      })) as { value: number };
      const upper = (await ctx.providerA.text.upper({
        value: `sum ${added.value}`,
      })) as { value: string };

      return {
        provider: "provider-b",
        route: "codemode-session-capability",
        toolFunction: "compose.addThenUpper",
        value: upper.value,
      };
    }

    if (path === "text.exclaim") {
      return {
        provider: "provider-b",
        toolFunction: "text.exclaim",
        value: `${String(input.payload.value).toUpperCase()}!`,
      };
    }

    throw new Error(`Provider B does not implement ${path}`);
  }

  async describeToolFunctions() {
    return {
      typeDefinitions: `{
  compose: {
    addThenUpper(input: { left: number; right: number }): Promise<{ value: string }>;
  };
  text: {
    exclaim(input: { value: string }): Promise<{ value: string }>;
  };
}`,
    };
  }
}

export default {
  fetch() {
    return new Response("codemode session test worker");
  },
};
