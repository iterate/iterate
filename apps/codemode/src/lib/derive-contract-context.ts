import {
  generateTypesFromJsonSchema,
  resolveProvider,
  sanitizeToolName,
  type JsonSchemaToolDescriptors,
} from "@cloudflare/codemode";
import { z } from "zod";

type ProcedureSchema = z.ZodType;

type ProcedureMeta = {
  route?: {
    description?: string;
    summary?: string;
    path?: string;
  };
  inputSchema?: ProcedureSchema;
  outputSchema?: ProcedureSchema;
};

type ContractProcedure = {
  "~orpc"?: ProcedureMeta;
};

interface ContractTree {
  [key: string]: ContractProcedure | ContractTree;
}

type ClientTree = Record<string, unknown>;

export interface ContractSpec {
  contract: ContractTree;
  client: ClientTree;
}

export type ContractRegistry = Record<string, ContractSpec>;

type ProcedureDescriptor = {
  rpcToolName: string;
  description: string;
  inputSchema: ProcedureSchema;
  outputSchema?: ProcedureSchema;
  runtimePath: string[];
  invoke: (input: unknown) => Promise<unknown>;
};

type ProcedureTreeNode = {
  children: Map<string, ProcedureTreeNode>;
  rpcToolName?: string;
};

export interface DerivedContractContext {
  ctxTypes: string;
  provider: ReturnType<typeof resolveProvider>;
  sandboxPrelude: string;
}

function isProcedure(value: unknown): value is ContractProcedure {
  return typeof value === "object" && value !== null && "~orpc" in value;
}

function createTreeNode(): ProcedureTreeNode {
  return {
    children: new Map(),
  };
}

function getClientProcedure(
  client: ClientTree,
  path: string[],
): (input: unknown) => Promise<unknown> {
  let current: unknown = client;

  for (const segment of path) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null) {
      throw new Error(`Missing client procedure at ${path.join(".")}`);
    }

    current = Reflect.get(current as object, segment);

    if (current === undefined) {
      throw new Error(`Missing client procedure at ${path.join(".")}`);
    }
  }

  if (typeof current !== "function") {
    throw new Error(`Client path ${path.join(".")} is not callable`);
  }

  return current as (input: unknown) => Promise<unknown>;
}

function collectProcedures(
  namespace: string,
  contract: ContractTree,
  client: ClientTree,
  rawPath: string[] = [],
  safePath: string[] = [],
): ProcedureDescriptor[] {
  const procedures: ProcedureDescriptor[] = [];

  for (const [rawKey, value] of Object.entries(contract)) {
    const safeKey = sanitizeToolName(rawKey);
    const nextRawPath = [...rawPath, rawKey];
    const nextSafePath = [...safePath, safeKey];

    if (isProcedure(value)) {
      const meta = value["~orpc"];

      if (!meta?.inputSchema) {
        continue;
      }

      const clientProcedure = getClientProcedure(client, nextRawPath);
      const rpcToolName = [sanitizeToolName(namespace), ...nextSafePath].join("__");

      procedures.push({
        rpcToolName,
        description:
          meta.route?.description ??
          meta.route?.summary ??
          meta.route?.path ??
          `${namespace}.${nextRawPath.join(".")}`,
        inputSchema: meta.inputSchema,
        outputSchema: meta.outputSchema,
        runtimePath: [namespace, ...nextRawPath],
        invoke: async (input: unknown) => {
          const parsedInput = meta.inputSchema!.parse(input ?? {});
          return clientProcedure(parsedInput);
        },
      });

      continue;
    }

    if (typeof value === "object" && value !== null) {
      procedures.push(
        ...collectProcedures(namespace, value as ContractTree, client, nextRawPath, nextSafePath),
      );
    }
  }

  return procedures;
}

function buildProcedureTree(procedures: ProcedureDescriptor[]): ProcedureTreeNode {
  const root = createTreeNode();

  for (const procedure of procedures) {
    let current = root;

    for (const segment of procedure.runtimePath) {
      let child = current.children.get(segment);
      if (!child) {
        child = createTreeNode();
        current.children.set(segment, child);
      }
      current = child;
    }

    current.rpcToolName = procedure.rpcToolName;
  }

  return root;
}

function emitRuntimeTree(node: ProcedureTreeNode, rootProviderName: string): string {
  const entries: string[] = [];

  for (const [segment, child] of node.children) {
    if (child.rpcToolName) {
      entries.push(
        `${JSON.stringify(segment)}: (input) => ${rootProviderName}.${child.rpcToolName}(input ?? {})`,
      );
      continue;
    }

    entries.push(`${JSON.stringify(segment)}: ${emitRuntimeTree(child, rootProviderName)}`);
  }

  return `{ ${entries.join(", ")} }`;
}

function emitTypeTree(node: ProcedureTreeNode, rootProviderName: string): string {
  const lines: string[] = ["{"];

  for (const [segment, child] of node.children) {
    if (child.rpcToolName) {
      lines.push(`  ${JSON.stringify(segment)}: typeof ${rootProviderName}.${child.rpcToolName};`);
      continue;
    }

    const nested = emitTypeTree(child, rootProviderName)
      .split("\n")
      .map((line, index) => (index === 0 ? line : `  ${line}`))
      .join("\n");
    lines.push(`  ${JSON.stringify(segment)}: ${nested};`);
  }

  lines.push("}");
  return lines.join("\n");
}

function buildToolDescriptors(procedures: ProcedureDescriptor[]): JsonSchemaToolDescriptors {
  return Object.fromEntries(
    procedures.map((procedure) => [
      procedure.rpcToolName,
      {
        description: procedure.description,
        inputSchema: z.toJSONSchema(procedure.inputSchema, {
          io: "input",
          unrepresentable: "any",
        }) as never,
        ...(procedure.outputSchema
          ? {
              outputSchema: z.toJSONSchema(procedure.outputSchema, {
                io: "output",
                unrepresentable: "any",
              }) as never,
            }
          : {}),
      },
    ]),
  ) as JsonSchemaToolDescriptors;
}

function collectAllProcedures(registry: ContractRegistry): ProcedureDescriptor[] {
  return Object.entries(registry).flatMap(([namespace, spec]) =>
    collectProcedures(namespace, spec.contract, spec.client),
  );
}

export function deriveContractContext(
  registry: ContractRegistry,
  options?: { providerName?: string },
): DerivedContractContext {
  const providerName = options?.providerName ?? "rpc";
  const procedures = collectAllProcedures(registry);
  const procedureTree = buildProcedureTree(procedures);
  const provider = resolveProvider({
    name: providerName,
    tools: Object.fromEntries(
      procedures.map((procedure) => [
        procedure.rpcToolName,
        {
          execute: procedure.invoke,
        },
      ]),
    ),
  });

  return {
    ctxTypes: [
      "// Generated from selected oRPC contracts via @cloudflare/codemode",
      generateTypesFromJsonSchema(buildToolDescriptors(procedures)).replace(
        "declare const codemode:",
        `declare const ${providerName}:`,
      ),
      "",
      `declare const ctx: ${emitTypeTree(procedureTree, providerName)};`,
      "",
    ].join("\n"),
    provider,
    sandboxPrelude: `const ctx = ${emitRuntimeTree(procedureTree, providerName)};`,
  };
}
