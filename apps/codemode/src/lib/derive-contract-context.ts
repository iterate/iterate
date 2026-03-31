import {
  generateTypesFromJsonSchema,
  jsonSchemaToType,
  sanitizeToolName,
  type JsonSchemaToolDescriptors,
} from "~/lib/codemode/index.ts";
import { getEventIteratorSchemaDetails } from "@orpc/contract";
import { z } from "zod";

type ProcedureSchema = unknown;

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

type ContractTree = Record<string, unknown>;
type ClientTree = Record<string, unknown>;

export interface ContractSpec {
  contract: ContractTree;
  client: ClientTree;
}

export type ContractRegistry = Record<string, ContractSpec>;
export type DerivedProviderMode = "value" | "stream";

export interface DerivedProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  mode: DerivedProviderMode;
  positionalArgs?: boolean;
}

type ProcedureDescriptor = {
  rpcToolName: string;
  description: string;
  inputSchema: ProcedureSchema;
  outputSchema?: ProcedureSchema;
  kind: DerivedProviderMode;
  runtimePath: string[];
  invoke: (input: unknown) => Promise<unknown>;
};

type ProcedureTreeNode = {
  children: Map<string, ProcedureTreeNode>;
  rpcToolName?: string;
};

export interface DerivedContractContext {
  ctxTypes: string;
  providers: DerivedProvider[];
  sandboxPrelude: string;
  declarations: string[];
  ctxExpression: string;
  ctxTypeExpression: string;
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
  return async (input: unknown) => {
    let current: unknown = client;
    let owner: unknown = undefined;

    for (const segment of path) {
      if ((typeof current !== "object" && typeof current !== "function") || current === null) {
        throw new Error(`Missing client procedure at ${path.join(".")}`);
      }

      owner = current;
      current = Reflect.get(current as object, segment);

      if (current === undefined) {
        throw new Error(`Missing client procedure at ${path.join(".")}`);
      }
    }

    if (typeof current !== "function") {
      throw new Error(`Client path ${path.join(".")} is not callable`);
    }

    return Reflect.apply(current, owner, [input]);
  };
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
      const streamDetails = getEventIteratorSchemaDetails(meta.outputSchema as never);

      procedures.push({
        rpcToolName,
        description:
          meta.route?.description ??
          meta.route?.summary ??
          meta.route?.path ??
          `${namespace}.${nextRawPath.join(".")}`,
        inputSchema: meta.inputSchema,
        outputSchema: streamDetails?.yields ?? meta.outputSchema,
        kind: streamDetails ? "stream" : "value",
        runtimePath: [namespace, ...nextRawPath],
        invoke: async (input: unknown) => {
          const parsedInput = (meta.inputSchema as z.ZodType).parse(input ?? {});
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

function findProcedure(procedures: ProcedureDescriptor[], rpcToolName: string) {
  return procedures.find((procedure) => procedure.rpcToolName === rpcToolName);
}

function emitRuntimeTree(
  node: ProcedureTreeNode,
  procedures: ProcedureDescriptor[],
  providerName: string,
): string {
  const entries: string[] = [];

  for (const [segment, child] of node.children) {
    if (child.rpcToolName) {
      const procedure = findProcedure(procedures, child.rpcToolName);
      const rootProviderName =
        procedure?.kind === "stream" ? `${providerName}_stream` : providerName;
      entries.push(
        `${JSON.stringify(segment)}: (input) => ${rootProviderName}.${child.rpcToolName}(input ?? {})`,
      );
      continue;
    }

    entries.push(`${JSON.stringify(segment)}: ${emitRuntimeTree(child, procedures, providerName)}`);
  }

  return `{ ${entries.join(", ")} }`;
}

function emitTypeTree(
  node: ProcedureTreeNode,
  procedures: ProcedureDescriptor[],
  providerName: string,
): string {
  const lines: string[] = ["{"];

  for (const [segment, child] of node.children) {
    if (child.rpcToolName) {
      const procedure = findProcedure(procedures, child.rpcToolName);
      const rootProviderName =
        procedure?.kind === "stream" ? `${providerName}_stream` : providerName;
      lines.push(`  ${JSON.stringify(segment)}: typeof ${rootProviderName}.${child.rpcToolName};`);
      continue;
    }

    const nested = emitTypeTree(child, procedures, providerName)
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
        inputSchema: z.toJSONSchema(procedure.inputSchema as z.ZodType, {
          io: "input",
          unrepresentable: "any",
        }) as never,
        ...(procedure.outputSchema
          ? {
              outputSchema: z.toJSONSchema(procedure.outputSchema as z.ZodType, {
                io: "output",
                unrepresentable: "any",
              }) as never,
            }
          : {}),
      },
    ]),
  ) as JsonSchemaToolDescriptors;
}

function toPascalCase(value: string) {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function buildStreamTypeDefinitions(procedures: ProcedureDescriptor[], providerName: string) {
  if (procedures.length === 0) {
    return "";
  }

  const declarations: string[] = [];
  const providerLines: string[] = [`declare const ${providerName}: {`];

  for (const procedure of procedures) {
    const baseName = toPascalCase(procedure.rpcToolName);
    const inputTypeName = `${baseName}Input`;
    const yieldTypeName = `${baseName}Yield`;

    declarations.push(
      jsonSchemaToType(
        z.toJSONSchema(procedure.inputSchema as z.ZodType, {
          io: "input",
          unrepresentable: "any",
        }) as never,
        inputTypeName,
      ),
    );

    if (procedure.outputSchema) {
      declarations.push(
        jsonSchemaToType(
          z.toJSONSchema(procedure.outputSchema as z.ZodType, {
            io: "output",
            unrepresentable: "any",
          }) as never,
          yieldTypeName,
        ),
      );
    } else {
      declarations.push(`type ${yieldTypeName} = unknown;`);
    }

    providerLines.push(
      `  ${JSON.stringify(procedure.rpcToolName)}: (input: ${inputTypeName}) => Promise<AsyncIterable<${yieldTypeName}>>;`,
    );
  }

  providerLines.push("};");
  return [...declarations, "", ...providerLines].join("\n");
}

function collectAllProcedures(registry: ContractRegistry): ProcedureDescriptor[] {
  return Object.entries(registry).flatMap(([namespace, spec]) =>
    collectProcedures(namespace, spec.contract, spec.client),
  );
}

export function deriveContractContext(
  registry: ContractRegistry,
  options?: { providerName?: string; includeTypes?: boolean },
): DerivedContractContext {
  const providerName = options?.providerName ?? "rpc";
  const includeTypes = options?.includeTypes !== false;
  const procedures = collectAllProcedures(registry);
  const procedureTree = buildProcedureTree(procedures);
  const valueProcedures = procedures.filter((procedure) => procedure.kind === "value");
  const streamProcedures = procedures.filter((procedure) => procedure.kind === "stream");
  const providers: DerivedProvider[] = [];

  if (valueProcedures.length > 0) {
    providers.push({
      name: providerName,
      mode: "value",
      fns: Object.fromEntries(
        valueProcedures.map((procedure) => [procedure.rpcToolName, procedure.invoke]),
      ),
    });
  }

  if (streamProcedures.length > 0) {
    providers.push({
      name: `${providerName}_stream`,
      mode: "stream",
      fns: Object.fromEntries(
        streamProcedures.map((procedure) => [procedure.rpcToolName, procedure.invoke]),
      ),
    });
  }

  return {
    declarations: includeTypes
      ? [
          "// Generated from selected oRPC contracts via @cloudflare/codemode",
          ...(valueProcedures.length > 0
            ? [
                generateTypesFromJsonSchema(buildToolDescriptors(valueProcedures)).replace(
                  "declare const codemode:",
                  `declare const ${providerName}:`,
                ),
              ]
            : []),
          ...(streamProcedures.length > 0
            ? ["", buildStreamTypeDefinitions(streamProcedures, `${providerName}_stream`)]
            : []),
        ]
      : [],
    providers,
    ctxExpression: emitRuntimeTree(procedureTree, procedures, providerName),
    ctxTypeExpression: emitTypeTree(procedureTree, procedures, providerName),
    sandboxPrelude: `const ctx = ${emitRuntimeTree(procedureTree, procedures, providerName)};`,
    ctxTypes: includeTypes
      ? [
          "// Generated from selected oRPC contracts via @cloudflare/codemode",
          ...(valueProcedures.length > 0
            ? [
                generateTypesFromJsonSchema(buildToolDescriptors(valueProcedures)).replace(
                  "declare const codemode:",
                  `declare const ${providerName}:`,
                ),
              ]
            : []),
          ...(streamProcedures.length > 0
            ? ["", buildStreamTypeDefinitions(streamProcedures, `${providerName}_stream`)]
            : []),
          "",
          `declare const ctx: ${emitTypeTree(procedureTree, procedures, providerName)};`,
          "",
        ].join("\n")
      : "",
  };
}
