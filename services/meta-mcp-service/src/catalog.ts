import type { NormalizedTool } from "./upstream-manager.ts";
import { MetaMcpError } from "./errors.ts";
import { renderSchemaTypeScript } from "./schema-to-typescript.ts";

function sanitizeName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^([^a-z]+)+/, "")
    .replace(/_+$/g, "");
  return sanitized || "item";
}

function tokenize(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const LOW_SIGNAL_QUERY_TOKENS = new Set([
  "a",
  "an",
  "the",
  "am",
  "as",
  "for",
  "from",
  "get",
  "i",
  "in",
  "is",
  "list",
  "me",
  "my",
  "of",
  "on",
  "or",
  "to",
  "who",
]);

function singularizeToken(value: string): string {
  return value.length > 3 && value.endsWith("s") ? value.slice(0, -1) : value;
}

function tokenEquals(left: string, right: string): boolean {
  return left === right || singularizeToken(left) === singularizeToken(right);
}

function hasTokenMatch(tokens: readonly string[], queryToken: string): boolean {
  return tokens.some((token) => tokenEquals(token, queryToken));
}

function hasSubstringMatch(value: string, queryToken: string): boolean {
  if (value.includes(queryToken)) {
    return true;
  }

  const singular = singularizeToken(queryToken);
  return singular !== queryToken && value.includes(singular);
}

function queryTokenWeight(token: string): number {
  return LOW_SIGNAL_QUERY_TOKENS.has(token) ? 0.25 : 1;
}

function extractSchemaPropertyKeys(schema: unknown): string[] {
  const keys = new Set<string>();
  const seen = new Set<object>();

  function visit(value: unknown) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (seen.has(value)) {
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = value as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [key, nested] of Object.entries(properties)) {
        keys.add(key);
        visit(nested);
      }
    }

    for (const nestedKey of ["items", "anyOf", "allOf", "oneOf", "prefixItems"] as const) {
      visit(record[nestedKey]);
    }
  }

  visit(schema);
  return [...keys];
}

function schemaJson(schema: unknown) {
  return schema === undefined ? undefined : JSON.stringify(schema, null, 2);
}

function typeNameFromSchema(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }

  const record = schema as Record<string, unknown>;
  if (typeof record.title === "string" && record.title.length > 0) {
    return record.title;
  }

  if (typeof record.type === "string") {
    return record.type;
  }

  if (record.properties && typeof record.properties === "object") {
    return "object";
  }

  return undefined;
}

interface CatalogToolDescriptor {
  path: string;
  sourceKey: string;
  description?: string;
  interaction: "auto";
  inputType?: string;
  outputType?: string;
  inputTypeScript?: string;
  outputTypeScript?: string;
  inputSchemaJson?: string;
  outputSchemaJson?: string;
}

interface CatalogTool extends CatalogToolDescriptor {
  namespace: string;
  serverId: string;
  toolName: string;
  callableName: string;
  inputSchema: unknown;
  outputSchema: unknown;
  parameterKeys: string[];
  searchText: string;
  pathTokens: string[];
  namespaceTokens: string[];
  descriptionTokens: string[];
  parameterTokens: string[];
  inputTypeScript?: string;
  outputTypeScript?: string;
}

interface CatalogNamespace {
  namespace: string;
  serverId: string;
  tools: CatalogTool[];
  error?: string;
}

interface PreparedCatalog {
  namespaces: CatalogNamespace[];
  byPath: Map<string, CatalogTool>;
}

function projectDescriptor(tool: CatalogTool, includeSchemas: boolean): CatalogToolDescriptor {
  if (includeSchemas) {
    return {
      path: tool.path,
      sourceKey: tool.sourceKey,
      description: tool.description,
      interaction: tool.interaction,
      inputType: tool.inputType,
      outputType: tool.outputType,
      inputTypeScript: tool.inputTypeScript,
      outputTypeScript: tool.outputTypeScript,
      inputSchemaJson: tool.inputSchemaJson,
      outputSchemaJson: tool.outputSchemaJson,
    };
  }

  return {
    path: tool.path,
    sourceKey: tool.sourceKey,
    description: tool.description,
    interaction: tool.interaction,
    inputType: tool.inputType,
    outputType: tool.outputType,
    inputTypeScript: tool.inputTypeScript,
    outputTypeScript: tool.outputTypeScript,
  };
}

function scoreTool(queryTokens: readonly string[], tool: CatalogTool): number {
  if (queryTokens.length === 0) {
    return 1;
  }

  let score = 0;
  let structuralHits = 0;
  let namespaceHits = 0;
  let pathHits = 0;

  for (const token of queryTokens) {
    const weight = queryTokenWeight(token);

    if (hasTokenMatch(tool.pathTokens, token)) {
      score += 12 * weight;
      structuralHits += 1;
      pathHits += 1;
      continue;
    }

    if (hasTokenMatch(tool.namespaceTokens, token)) {
      score += 11 * weight;
      structuralHits += 1;
      namespaceHits += 1;
      continue;
    }

    if (hasTokenMatch(tool.parameterTokens, token)) {
      score += 9 * weight;
      structuralHits += 1;
      continue;
    }

    if (hasTokenMatch(tool.descriptionTokens, token)) {
      score += 3 * weight;
      continue;
    }

    if (hasSubstringMatch(tool.path, token)) {
      score += 6 * weight;
      structuralHits += 1;
      pathHits += 1;
      continue;
    }

    if (
      hasSubstringMatch(tool.namespace, token) ||
      hasSubstringMatch(tool.serverId.toLowerCase(), token)
    ) {
      score += 5 * weight;
      structuralHits += 1;
      namespaceHits += 1;
      continue;
    }

    if (hasSubstringMatch(tool.searchText, token)) {
      score += 0.5 * weight;
    }
  }

  const strongTokens = queryTokens.filter((token) => queryTokenWeight(token) >= 1);
  if (strongTokens.length >= 2) {
    for (let index = 0; index < strongTokens.length - 1; index += 1) {
      const current = strongTokens[index]!;
      const next = strongTokens[index + 1]!;
      const phrases = [`${current}_${next}`, `${current}.${next}`, `${current}/${next}`];
      if (phrases.some((phrase) => tool.path.includes(phrase))) {
        score += 10;
      }
    }
  }

  if (namespaceHits > 0 && pathHits > 0) {
    score += 8;
  }

  if (structuralHits === 0 && score > 0) {
    score *= 0.25;
  }

  return score;
}

export function buildCatalog(params: {
  servers: Array<{
    server: { id: string; namespace?: string };
    tools: NormalizedTool[];
    error?: string;
  }>;
  builtins?: Array<{
    namespace: string;
    sourceKey: string;
    tools: Array<NormalizedTool & { callableName?: string }>;
  }>;
}): PreparedCatalog {
  const usedNamespaces = new Set<string>();
  const namespaces: CatalogNamespace[] = [];
  const byPath = new Map<string, CatalogTool>();
  const reservedNamespaces = new Set(["discover", "describe", "catalog", "metamcp", "addServer"]);

  for (const entry of params.servers) {
    const requestedNamespace = entry.server.namespace ?? entry.server.id;
    const namespace = sanitizeName(requestedNamespace);

    if (reservedNamespaces.has(namespace) || usedNamespaces.has(namespace)) {
      throw new MetaMcpError("NAMESPACE_CONFLICT", `Namespace '${namespace}' is unavailable`, {
        serverId: entry.server.id,
        namespace,
      });
    }

    usedNamespaces.add(namespace);

    const seenCallableNames = new Set<string>();
    const tools = entry.tools.map((tool) => {
      const baseName = sanitizeName(tool.name);
      let callableName = baseName;
      let index = 2;
      while (seenCallableNames.has(callableName)) {
        callableName = `${baseName}_${index}`;
        index += 1;
      }
      seenCallableNames.add(callableName);

      const path = `${namespace}.${callableName}`;
      const descriptor: CatalogTool = {
        path,
        namespace,
        serverId: entry.server.id,
        sourceKey: entry.server.id,
        toolName: tool.name,
        callableName,
        description: tool.description || undefined,
        interaction: "auto",
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        inputType: typeNameFromSchema(tool.inputSchema),
        outputType: typeNameFromSchema(tool.outputSchema),
        inputTypeScript: renderSchemaTypeScript({
          toolPath: path,
          kind: "input",
          schema: tool.inputSchema,
        }),
        outputTypeScript: renderSchemaTypeScript({
          toolPath: path,
          kind: "output",
          schema: tool.outputSchema,
        }),
        inputSchemaJson: schemaJson(tool.inputSchema),
        outputSchemaJson: schemaJson(tool.outputSchema),
        parameterKeys: extractSchemaPropertyKeys(tool.inputSchema),
        searchText: [path, entry.server.id, tool.name, tool.description ?? ""]
          .join(" ")
          .toLowerCase(),
        pathTokens: tokenize(`${path} ${tool.name}`),
        namespaceTokens: tokenize(`${namespace} ${entry.server.id}`),
        descriptionTokens: tokenize(tool.description ?? ""),
        parameterTokens: tokenize(extractSchemaPropertyKeys(tool.inputSchema).join(" ")),
      };

      byPath.set(path, descriptor);
      return descriptor;
    });

    namespaces.push({
      namespace,
      serverId: entry.server.id,
      tools,
      error: entry.error,
    });
  }

  for (const builtin of params.builtins ?? []) {
    const namespace = sanitizeName(builtin.namespace);
    if (usedNamespaces.has(namespace)) {
      throw new MetaMcpError("NAMESPACE_CONFLICT", `Namespace '${namespace}' is unavailable`, {
        serverId: builtin.sourceKey,
        namespace,
      });
    }

    usedNamespaces.add(namespace);

    const seenCallableNames = new Set<string>();
    const tools = builtin.tools.map((tool) => {
      const baseName = tool.callableName ?? sanitizeName(tool.name);
      let callableName = baseName;
      let index = 2;
      while (seenCallableNames.has(callableName)) {
        callableName = `${baseName}_${index}`;
        index += 1;
      }
      seenCallableNames.add(callableName);

      const path = `${namespace}.${callableName}`;
      const descriptor: CatalogTool = {
        path,
        namespace,
        serverId: builtin.sourceKey,
        sourceKey: builtin.sourceKey,
        toolName: tool.name,
        callableName,
        description: tool.description || undefined,
        interaction: "auto",
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        inputType: typeNameFromSchema(tool.inputSchema),
        outputType: typeNameFromSchema(tool.outputSchema),
        inputTypeScript: renderSchemaTypeScript({
          toolPath: path,
          kind: "input",
          schema: tool.inputSchema,
        }),
        outputTypeScript: renderSchemaTypeScript({
          toolPath: path,
          kind: "output",
          schema: tool.outputSchema,
        }),
        inputSchemaJson: schemaJson(tool.inputSchema),
        outputSchemaJson: schemaJson(tool.outputSchema),
        parameterKeys: extractSchemaPropertyKeys(tool.inputSchema),
        searchText: [path, builtin.sourceKey, tool.name, tool.description ?? ""]
          .join(" ")
          .toLowerCase(),
        pathTokens: tokenize(`${path} ${tool.name}`),
        namespaceTokens: tokenize(`${namespace} ${builtin.sourceKey}`),
        descriptionTokens: tokenize(tool.description ?? ""),
        parameterTokens: tokenize(extractSchemaPropertyKeys(tool.inputSchema).join(" ")),
      };

      byPath.set(path, descriptor);
      return descriptor;
    });

    namespaces.push({
      namespace,
      serverId: builtin.sourceKey,
      tools,
    });
  }

  return {
    namespaces,
    byPath,
  };
}

export function catalogNamespaces(params: { catalog: PreparedCatalog; limit?: number }) {
  return {
    namespaces: params.catalog.namespaces.slice(0, params.limit ?? 200).map((record) => ({
      namespace: record.namespace,
      displayName: record.serverId,
      toolCount: record.tools.length,
      ...(record.error ? { error: record.error } : {}),
    })),
  };
}

export function catalogTools(params: {
  catalog: PreparedCatalog;
  namespace?: string;
  query?: string;
  limit?: number;
  includeSchemas?: boolean;
}) {
  const queryTokens = tokenize(params.query ?? "");
  const results = params.catalog.namespaces
    .filter((record) => (params.namespace ? record.namespace === params.namespace : true))
    .flatMap((record) => record.tools)
    .filter((tool) => {
      if (queryTokens.length === 0) {
        return true;
      }

      return queryTokens.every((token) => tool.searchText.includes(token));
    })
    .slice(0, params.limit ?? 200)
    .map((tool) => projectDescriptor(tool, params.includeSchemas ?? false));

  return { results };
}

export function describeTool(params: {
  catalog: PreparedCatalog;
  path: string;
  includeSchemas?: boolean;
}) {
  const tool = params.catalog.byPath.get(params.path);
  if (!tool) {
    throw new MetaMcpError("TOOL_NOT_FOUND", `Unknown tool '${params.path}'`, {
      toolPath: params.path,
    });
  }

  return projectDescriptor(tool, params.includeSchemas ?? false);
}

export function discoverCatalog(params: {
  catalog: PreparedCatalog;
  query: string;
  limit?: number;
  includeSchemas?: boolean;
}) {
  const queryTokens = tokenize(params.query);
  const hits = params.catalog.namespaces
    .flatMap((record) => record.tools)
    .map((tool) => ({
      tool,
      score: scoreTool(queryTokens, tool),
    }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, params.limit ?? 12)
    .map((hit) => ({
      path: hit.tool.path,
      score: hit.score,
      description: hit.tool.description,
      interaction: hit.tool.interaction,
      inputType: hit.tool.inputType,
      outputType: hit.tool.outputType,
      inputTypeScript: hit.tool.inputTypeScript,
      outputTypeScript: hit.tool.outputTypeScript,
      ...((params.includeSchemas ?? false)
        ? {
            inputSchemaJson: hit.tool.inputSchemaJson,
            outputSchemaJson: hit.tool.outputSchemaJson,
          }
        : {}),
    }));

  return {
    bestPath: hits[0]?.path ?? null,
    results: hits,
    total: hits.length,
  };
}
