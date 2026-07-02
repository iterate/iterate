// Gmail REST proxy, ported from the pre-migration google entrypoints'
// gmail-capability.ts. The access token comes from google-tokens.ts (fresh,
// refreshed itx-side).

import type { GmailRequestInput } from "../../types.ts";

export async function callGmailApi(input: { request: GmailRequestInput; token: string }) {
  const method = (input.request.method ?? "GET").trim().toUpperCase();
  const url = gmailUrl(input.request);
  const response = await fetch(url, {
    method,
    headers: {
      ...(input.request.body === undefined ? {} : { "content-type": "application/json" }),
      ...(input.request.headers ?? {}),
      authorization: `Bearer ${input.token}`,
    },
    ...(input.request.body === undefined || method === "GET" || method === "HEAD"
      ? {}
      : { body: JSON.stringify(input.request.body) }),
  });

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
