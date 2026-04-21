// Egress gateway — intercepts all outbound fetch() from dynamically loaded app code,
// scans for getIterateSecret({secretKey:"..."}) sentinel strings, resolves them from D1,
// and forwards the request with real secret values substituted.

import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  DB: D1Database;
}

const PROJECT_SLUG_HEADER = "x-iterate-project-slug";

// ── Secret reference parsing (inlined from apps/events/src/lib/iterate-secret-references.ts) ──

type SecretMatch = {
  encoding: "raw" | "urlencoded";
  end: number;
  raw: string;
  secretKey: string;
  start: number;
};

const rawPattern = /getIterateSecret\(\{secretKey:\s*(?:"([^"]+)"|'([^']+)')\}\)/g;
const urlEncodedPattern =
  /getIterateSecret%28%7BsecretKey%3A(?:%20|\+)*(?:%22([^%]+)%22|%27([^%]+)%27)%7D%29/gi;

function findSecretReferences(input: string): SecretMatch[] {
  return [
    ...collectMatches(input, rawPattern, "raw"),
    ...collectMatches(input, urlEncodedPattern, "urlencoded"),
  ].sort((a, b) => a.start - b.start);
}

function collectMatches(
  input: string,
  pattern: RegExp,
  encoding: SecretMatch["encoding"],
): SecretMatch[] {
  pattern.lastIndex = 0;
  const matches: SecretMatch[] = [];
  for (let m = pattern.exec(input); m != null; m = pattern.exec(input)) {
    const secretKey = m[1] ?? m[2];
    if (typeof secretKey !== "string" || secretKey.length === 0) continue;
    matches.push({
      encoding,
      end: m.index + m[0].length,
      raw: m[0],
      secretKey,
      start: m.index,
    });
  }
  return matches;
}

async function replaceSecretReferences(
  input: string,
  loadSecret: (key: string) => Promise<string>,
): Promise<{ output: string; secretKeys: string[] }> {
  const matches = findSecretReferences(input);
  if (matches.length === 0) return { output: input, secretKeys: [] };

  let cursor = 0;
  let output = "";
  const secretKeys: string[] = [];

  for (const match of matches) {
    output += input.slice(cursor, match.start);
    output += await loadSecret(match.secretKey);
    secretKeys.push(match.secretKey);
    cursor = match.end;
  }
  output += input.slice(cursor);
  return { output, secretKeys };
}

// ── EgressGateway ──

export class EgressGateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    const projectSlug = headers.get(PROJECT_SLUG_HEADER);
    headers.delete(PROJECT_SLUG_HEADER);

    // No project slug → pass through unchanged
    if (!projectSlug) {
      return fetch(new Request(request, { headers }));
    }

    const resolvedSecretKeys = new Set<string>();
    const replacedHeaderNames: string[] = [];

    const loadSecret = async (secretKey: string): Promise<string> => {
      const row = await this.env.DB.prepare(
        "SELECT value FROM secrets WHERE project_slug = ? AND name = ?",
      )
        .bind(projectSlug, secretKey)
        .first<{ value: string }>();

      if (typeof row?.value !== "string") {
        throw new Error(`Secret "${secretKey}" not found in project "${projectSlug}"`);
      }
      return row.value;
    };

    let url = request.url;
    try {
      // Scan + replace in headers
      for (const [headerName, headerValue] of Array.from(headers.entries())) {
        const result = await replaceSecretReferences(headerValue, loadSecret);
        if (result.secretKeys.length === 0) continue;
        headers.set(headerName, result.output);
        replacedHeaderNames.push(headerName);
        for (const k of result.secretKeys) resolvedSecretKeys.add(k);
      }

      // Scan + replace in URL
      const urlResult = await replaceSecretReferences(url, loadSecret);
      if (urlResult.secretKeys.length > 0) {
        url = urlResult.output;
        for (const k of urlResult.secretKeys) resolvedSecretKeys.add(k);
      }
    } catch (error) {
      console.error("[EgressGateway] secret resolution failed", {
        error: error instanceof Error ? error.message : error,
        projectSlug,
        secretKeys: Array.from(resolvedSecretKeys),
      });
      return new Response(
        JSON.stringify({
          error: "Secret resolution failed",
          message: error instanceof Error ? error.message : String(error),
        }),
        { status: 424, headers: { "content-type": "application/json" } },
      );
    }

    if (resolvedSecretKeys.size > 0) {
      console.log("[EgressGateway] resolved secrets", {
        headerNames: replacedHeaderNames,
        method: request.method,
        projectSlug,
        secretKeys: Array.from(resolvedSecretKeys),
        url: new URL(request.url).origin,
      });
    }

    return fetch(new Request(url, { method: request.method, headers, body: request.body }));
  }
}
