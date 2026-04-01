import JSON5 from "json5";

const MAGIC_STRING_PATTERN_SOURCE = String.raw`getIterateSecret\(\s*\{([^}]+)\}\s*\)`;
export const MAGIC_STRING_PATTERN = new RegExp(MAGIC_STRING_PATTERN_SOURCE, "g");

function createMagicStringPattern(): RegExp {
  return new RegExp(MAGIC_STRING_PATTERN_SOURCE, "g");
}

export type CodemodeSecretError = {
  code: "NOT_FOUND";
  message: string;
};

export type ParsedSecret = {
  secretKey: string;
};

type ReplaceMagicStringsResult =
  | { ok: true; result: string }
  | { ok: false; error: CodemodeSecretError };

const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailers",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
]);

const STRIP_RESPONSE_HEADERS = new Set(["transfer-encoding", "connection", "keep-alive"]);

export function hasMagicString(input: string): boolean {
  return createMagicStringPattern().test(input);
}

export function parseMagicString(match: string): ParsedSecret | null {
  const objectMatch = match.match(/\{[^}]+\}/);
  if (!objectMatch) {
    return null;
  }

  try {
    const parsed = JSON5.parse(objectMatch[0]) as { secretKey?: string };
    if (!parsed.secretKey || typeof parsed.secretKey !== "string") {
      return null;
    }

    return {
      secretKey: parsed.secretKey,
    };
  } catch {
    return null;
  }
}

async function lookupCodemodeSecret(db: D1Database, secretKey: string) {
  const row = await db
    .prepare("select id, key, value from codemode_secrets where key = ?1 limit 1")
    .bind(secretKey)
    .first<{ id: string; key: string; value: string }>();

  return row ?? null;
}

export async function replaceMagicStrings(
  db: D1Database,
  input: string,
): Promise<ReplaceMagicStringsResult> {
  const matches = [...input.matchAll(createMagicStringPattern())];

  if (matches.length === 0) {
    return {
      ok: true,
      result: input,
    };
  }

  let result = input;

  for (const match of matches) {
    const fullMatch = match[0];
    const parsed = parseMagicString(fullMatch);

    if (!parsed) {
      continue;
    }

    const secret = await lookupCodemodeSecret(db, parsed.secretKey);
    if (!secret) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Secret '${parsed.secretKey}' not found. Add it in codemode secrets first.`,
        },
      };
    }

    result = result.replace(fullMatch, secret.value);
  }

  return {
    ok: true,
    result,
  };
}

export async function processHeaderValue(
  db: D1Database,
  headerName: string,
  headerValue: string,
): Promise<ReplaceMagicStringsResult> {
  const basicAuthMatch = headerValue.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);

  if (basicAuthMatch && headerName.toLowerCase() === "authorization") {
    let decoded: string;

    try {
      decoded = atob(basicAuthMatch[1] ?? "");
    } catch {
      return replaceMagicStrings(db, headerValue);
    }

    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // noop
    }

    if (!hasMagicString(decoded)) {
      return {
        ok: true,
        result: headerValue,
      };
    }

    const replaced = await replaceMagicStrings(db, decoded);
    if (!replaced.ok) {
      return replaced;
    }

    return {
      ok: true,
      result: `Basic ${btoa(replaced.result)}`,
    };
  }

  return replaceMagicStrings(db, headerValue);
}

function hasRequestBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

export function createSecretErrorResponse(error: CodemodeSecretError): Response {
  return Response.json(
    {
      error: error.code.toLowerCase(),
      code: error.code,
      message: error.message,
    },
    { status: 424 },
  );
}

export async function forwardCodemodeRequest(options: {
  db: D1Database;
  request: Request;
}): Promise<Response> {
  const originalUrl = options.request.url;
  const processedUrlResult = await replaceMagicStrings(options.db, originalUrl);

  if (!processedUrlResult.ok) {
    return createSecretErrorResponse(processedUrlResult.error);
  }

  const forwardHeaders = new Headers();

  for (const [key, value] of options.request.headers) {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      continue;
    }

    const processedHeaderResult = await processHeaderValue(options.db, key, value);
    if (!processedHeaderResult.ok) {
      return createSecretErrorResponse(processedHeaderResult.error);
    }

    forwardHeaders.set(key, processedHeaderResult.result);
  }

  const upstreamResponse = await fetch(processedUrlResult.result, {
    method: options.request.method,
    headers: forwardHeaders,
    body: hasRequestBody(options.request.method) ? options.request.body : undefined,
    redirect: options.request.redirect,
  });

  const responseHeaders = new Headers();
  upstreamResponse.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
