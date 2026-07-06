// Gmail REST proxy (v6): the request goes through the connection secret's
// fetch (the jailed refresh worker) carrying a `getSecret(...)` Authorization
// placeholder — the secret substitutes the fresh access token and refreshes on
// 401. No token bytes ever reach this code (design §3).

import type { GmailRequestInput } from "../../types.ts";

export async function callGmailApi(input: {
  /** The Gmail REST call. */
  request: GmailRequestInput;
  /** The Authorization header VALUE — a `Bearer getSecret(...)` placeholder the
   * connection secret substitutes; never a raw token. */
  authorization: string;
  /** Sends the composed request through the connection secret's fetch (the DO
   * stub), which runs the refresh worker (substitute + 401→refresh→retry). */
  send: (request: Request) => Promise<Response>;
}) {
  const method = (input.request.method ?? "GET").trim().toUpperCase();
  const url = gmailUrl(input.request);
  const response = await input.send(
    new Request(url, {
      method,
      headers: {
        ...(input.request.body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.request.headers ?? {}),
        authorization: input.authorization,
      },
      ...(input.request.body === undefined || method === "GET" || method === "HEAD"
        ? {}
        : { body: JSON.stringify(input.request.body) }),
    }),
  );

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    throw new Error(
      `Gmail API ${method} ${url.pathname} failed with HTTP ${response.status}: ${formatErrorData(data)}`,
    );
  }

  return {
    data,
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
    statusText: response.statusText,
  };
}

function gmailUrl(input: GmailRequestInput) {
  const path = input.path.trim();
  if (!path) throw new Error("gmail.request requires a non-empty path.");
  const base = "https://gmail.googleapis.com/gmail/v1";
  const url = path.startsWith("https://gmail.googleapis.com/gmail/v1/")
    ? new URL(path)
    : new URL(path.startsWith("/") ? `${base}${path}` : `${base}/${path}`);

  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value == null) continue;
    url.searchParams.set(key, String(value));
  }

  return url;
}

function formatErrorData(value: unknown) {
  if (typeof value === "string") return value.slice(0, 1000);
  try {
    return JSON.stringify(value).slice(0, 1000);
  } catch {
    return String(value);
  }
}
