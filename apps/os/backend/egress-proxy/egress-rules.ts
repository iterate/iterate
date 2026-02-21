import jsonata, { type Expression } from "jsonata";
import { logger } from "../tag-logger.ts";

// Cache for compiled JSONata expressions (module-level, persists across requests in same isolate)
// Limited to 100 entries to prevent unbounded memory growth
const JSONATA_CACHE_MAX_SIZE = 100;
const jsonataCache = new Map<string, Expression>();

function getCompiledJsonata(expression: string): Expression {
  let compiled = jsonataCache.get(expression);
  if (!compiled) {
    if (jsonataCache.size >= JSONATA_CACHE_MAX_SIZE) {
      const firstKey = jsonataCache.keys().next().value;
      if (firstKey) jsonataCache.delete(firstKey);
    }
    compiled = jsonata(expression);
    jsonataCache.set(expression, compiled);
  }
  return compiled;
}

type EgressRuleContext = {
  url: {
    hostname: string;
    pathname: string;
    href: string;
    protocol: string;
    port: string;
  };
  headers: Record<string, string>;
  body?: string;
  method?: string;
};

/**
 * Validate that a JSONata expression is syntactically valid.
 * Returns null if valid, or an error message if invalid.
 */
export function validateJsonataExpression(expression: string): string | null {
  try {
    jsonata(expression);
    return null;
  } catch (err) {
    if (err instanceof Error) {
      return err.message;
    }
    if (typeof err === "object" && err !== null && "message" in err) {
      return String((err as { message: unknown }).message);
    }
    return "Invalid JSONata expression";
  }
}

/**
 * Evaluate a JSONata egress rule expression against request data.
 * Returns true if the rule matches (allows/flags the request), false otherwise.
 *
 * Example rules:
 * - `url.hostname = 'api.openai.com'` - exact hostname match
 * - `$contains(url.hostname, 'googleapis.com')` - contains match
 * - `url.hostname = 'api.openai.com' or url.hostname = 'api.anthropic.com'` - OR
 */
export async function matchesEgressRule(
  urlString: string,
  expression: string,
  headers?: Record<string, string>,
  body?: string,
  method?: string,
): Promise<boolean> {
  try {
    const url = new URL(urlString.startsWith("http") ? urlString : `https://${urlString}`);
    const context: EgressRuleContext = {
      url: {
        hostname: url.hostname,
        pathname: url.pathname,
        href: url.href,
        protocol: url.protocol,
        port: url.port,
      },
      headers: headers ?? {},
      body,
      method,
    };
    const expr = getCompiledJsonata(expression);
    const result = await expr.evaluate(context);
    return !!result;
  } catch (err) {
    logger.error("Failed to evaluate egress rule", err, {
      expression,
      url: urlString,
    });
    return false;
  }
}
