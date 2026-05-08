import jsonata, { type Expression } from "jsonata";

const jsonataCache = new Map<string, Expression>();

export function getCompiledJsonata(expression: string) {
  const cached = jsonataCache.get(expression);
  if (cached) {
    return cached;
  }

  if (jsonataCache.size >= 100) {
    const oldestKey = jsonataCache.keys().next().value;
    if (oldestKey) {
      jsonataCache.delete(oldestKey);
    }
  }

  const compiled = jsonata(expression);
  jsonataCache.set(expression, compiled);
  return compiled;
}
