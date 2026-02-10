/**
 * File-backed policy store with JSONata matching for HTTP and WS.
 *
 * Default deny: if no policy matches, the request is denied.
 * Policies are evaluated in priority order (lowest number = highest priority).
 * First match wins.
 *
 * Decisions: allow, deny/drop (synonyms), human_approval, rewrite.
 */

import fs from "node:fs";
import jsonata, { type Expression } from "jsonata";
import type { Logger } from "./utils.ts";

export type PolicyDecision = "allow" | "deny" | "drop" | "human_approval" | "rewrite";

export type Policy = {
  priority: number;
  expression: string;
  decision: PolicyDecision;
  reason?: string;
  /** For rewrite decisions */
  rewriteFrom?: string;
  /** For rewrite decisions */
  rewriteTo?: string;
  /** Optional explicit scope filter */
  scope?: "http" | "ws";
};

export type PoliciesFile = {
  policies: Policy[];
};

export type PolicyCheckResult = {
  decision: PolicyDecision;
  policy?: Policy;
  reason?: string;
};

/**
 * Unified context for policy evaluation. HTTP and WS fields are a superset;
 * absent fields are undefined so expressions naturally self-select.
 */
export type PolicyContext = {
  // HTTP fields
  url?: { hostname: string; pathname: string; href: string; protocol: string; port: string };
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  // WS fields
  payload?: string | null;
  bytes?: number;
  direction?: "c2u" | "u2c";
  target?: { hostname: string; href: string; protocol: string };
  json?: unknown;
};

// Cache compiled JSONata expressions to avoid re-parsing
const JSONATA_CACHE_MAX = 100;
const jsonataCache = new Map<string, Expression>();

function getCompiled(expression: string): Expression {
  let compiled = jsonataCache.get(expression);
  if (!compiled) {
    if (jsonataCache.size >= JSONATA_CACHE_MAX) {
      const firstKey = jsonataCache.keys().next().value;
      if (firstKey) jsonataCache.delete(firstKey);
    }
    compiled = jsonata(expression);
    jsonataCache.set(expression, compiled);
  }
  return compiled;
}

/**
 * Evaluate a JSONata expression against a context. Returns true if truthy.
 */
export async function evaluateExpression(
  expression: string,
  context: PolicyContext,
): Promise<boolean> {
  try {
    const expr = getCompiled(expression);
    const result = await expr.evaluate(context);
    return !!result;
  } catch {
    return false;
  }
}

/**
 * Evaluate a JSONata egress rule against a URL string.
 * Used by the secret store to check egress rules on secrets.
 */
export async function matchesEgressRule(rule: string, urlString: string): Promise<boolean> {
  try {
    const url = new URL(urlString.startsWith("http") ? urlString : `https://${urlString}`);
    const context: PolicyContext = {
      url: {
        hostname: url.hostname,
        pathname: url.pathname,
        href: url.href,
        protocol: url.protocol,
        port: url.port,
      },
    };
    return evaluateExpression(rule, context);
  } catch {
    return false;
  }
}

/**
 * Build a PolicyContext from an HTTP request target URL + headers + body.
 */
export function buildHttpContext(
  targetUrl: string,
  method: string,
  headers?: Headers,
  body?: string,
): PolicyContext {
  const url = new URL(targetUrl);
  const headerRecord: Record<string, string> = {};
  if (headers) {
    headers.forEach((value, key) => {
      headerRecord[key.toLowerCase()] = value;
    });
  }
  return {
    url: {
      hostname: url.hostname,
      pathname: url.pathname,
      href: url.href,
      protocol: url.protocol,
      port: url.port,
    },
    method: method.toUpperCase(),
    headers: headerRecord,
    body,
  };
}

/**
 * Build a PolicyContext from a WS message.
 */
export function buildWsContext(
  payload: string | null,
  bytes: number,
  direction: "c2u" | "u2c",
  targetUrl: string,
): PolicyContext {
  let parsedJson: unknown;
  if (payload !== null) {
    try {
      parsedJson = JSON.parse(payload);
    } catch {
      // not JSON, that's fine
    }
  }

  let target: PolicyContext["target"];
  try {
    const url = new URL(targetUrl);
    target = {
      hostname: url.hostname,
      href: url.href,
      protocol: url.protocol,
    };
  } catch {
    // invalid URL, leave target undefined
  }

  return {
    payload,
    bytes,
    direction,
    target,
    json: parsedJson,
  };
}

export type PolicyStore = {
  check: (context: PolicyContext, scope: "http" | "ws") => Promise<PolicyCheckResult>;
  getPolicies: () => Policy[];
  getCount: () => number;
};

export function createPolicyStore(filePath: string, logger: Logger): PolicyStore {
  let policies: Policy[] = [];

  function load(): void {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as PoliciesFile;
      policies = [...parsed.policies].sort((a, b) => a.priority - b.priority);
      logger.appendLog(`POLICIES_LOAD count=${policies.length} path=${filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.appendLog(`POLICIES_LOAD path=${filePath} not_found (default deny)`);
        policies = [];
      } else {
        logger.appendLog(`POLICIES_LOAD_ERROR ${message} (keeping previous policies)`);
      }
    }
  }

  // Initial load
  load();

  // Watch for changes
  fs.watchFile(filePath, { interval: 1000 }, () => {
    load();
  });

  async function check(context: PolicyContext, scope: "http" | "ws"): Promise<PolicyCheckResult> {
    for (const policy of policies) {
      // Skip if policy has explicit scope that doesn't match
      if (policy.scope && policy.scope !== scope) continue;

      const matched = await evaluateExpression(policy.expression, context);
      if (matched) {
        return {
          decision: policy.decision,
          policy,
          reason: policy.reason,
        };
      }
    }

    // Default deny
    return { decision: "deny", reason: "no matching policy (default deny)" };
  }

  return {
    check,
    getPolicies: () => [...policies],
    getCount: () => policies.length,
  };
}
