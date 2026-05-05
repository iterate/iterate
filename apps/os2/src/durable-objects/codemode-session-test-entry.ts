import { WorkerEntrypoint } from "cloudflare:workers";
import { createCodemodeContext } from "@iterate-com/shared/codemode/context-proxy";
import { DESCRIBE_TOOL_FUNCTION_NAME } from "@iterate-com/shared/codemode/types";

export { CodemodeSession } from "./codemode-session.ts";

type ToolFunctionInput = {
  codemodeSessionCapability: Parameters<
    typeof createCodemodeContext
  >[0]["codemodeSessionCapability"];
  path: string[];
  input: Record<string, unknown>;
};

export class ProviderA extends WorkerEntrypoint {
  async executeToolFunction(input: ToolFunctionInput) {
    const path = input.path.join(".");

    if (path === DESCRIBE_TOOL_FUNCTION_NAME) {
      return providerATypeDefinitions();
    }

    if (path === "compose.exclaimViaB") {
      const ctx = createCodemodeContext({
        codemodeSessionCapability: input.codemodeSessionCapability,
      });
      const result = (await ctx.providerB.text.exclaim({
        value: input.input.value,
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
        value: Number(input.input.left) + Number(input.input.right),
      };
    }

    if (path === "text.upper") {
      return {
        provider: "provider-a",
        toolFunction: "text.upper",
        value: String(input.input.value).toUpperCase(),
      };
    }

    throw new Error(`Provider A does not implement ${path}`);
  }
}

export class ProviderB extends WorkerEntrypoint {
  async executeToolFunction(input: ToolFunctionInput) {
    const path = input.path.join(".");

    if (path === DESCRIBE_TOOL_FUNCTION_NAME) {
      return providerBTypeDefinitions();
    }

    if (path === "compose.addThenUpper") {
      const ctx = createCodemodeContext({
        codemodeSessionCapability: input.codemodeSessionCapability,
      });
      const added = (await ctx.providerA.math.add({
        left: input.input.left,
        right: input.input.right,
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
        value: `${String(input.input.value).toUpperCase()}!`,
      };
    }

    throw new Error(`Provider B does not implement ${path}`);
  }
}

function providerATypeDefinitions() {
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

function providerBTypeDefinitions() {
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

export default {
  fetch() {
    return new Response("codemode session test worker");
  },
};
