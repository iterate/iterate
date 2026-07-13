import { SecretSubstitutionError } from "./utils.ts";

export const MAX_CREDENTIAL_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
] as const;

/**
 * Fetch a request that carries credential material without delegating redirect
 * policy to the runtime. Each Location is resolved and re-authorized before a
 * new Request is built. Same-origin redirects retain the request; cross-origin
 * redirects are rejected because credentials may live in any header or body.
 */
export async function fetchWithCredentialRedirects(
  request: Request,
  options: {
    /** Re-check the destination's credential-specific allowlist on every hop. */
    assertUrlAllowed?: (url: string) => void;
    /** Test seam; production always uses the Workers global fetch. */
    fetcher?: (request: Request) => Promise<Response>;
  } = {},
): Promise<Response> {
  const fetcher = options.fetcher ?? ((outbound: Request) => fetch(outbound));
  let current = new Request(request, { redirect: "manual" });
  assertHttpUrl(current.url);
  options.assertUrlAllowed?.(current.url);

  for (let redirects = 0; ; redirects += 1) {
    // Preserve an undisturbed copy before fetch consumes the current body. A
    // 307/308 (or non-POST 301/302) may need to replay it on the next hop.
    const redirectSource = current.clone() as unknown as Request;
    const response = await fetcher(current);
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (location === null) return response;

    try {
      if (redirects >= MAX_CREDENTIAL_REDIRECTS) {
        throw new Error(`credential fetch exceeded ${MAX_CREDENTIAL_REDIRECTS} redirects`);
      }

      const nextUrl = new URL(location, redirectSource.url);
      assertHttpUrl(nextUrl.href);
      options.assertUrlAllowed?.(nextUrl.href);

      if (nextUrl.origin !== new URL(redirectSource.url).origin) {
        throw new SecretSubstitutionError("secret_not_allowed_for_origin");
      }

      current = buildRedirectRequest(redirectSource, nextUrl, response.status);
    } catch (error) {
      await cancelBody(response);
      throw error;
    }
    await cancelBody(response);
  }
}

function assertHttpUrl(url: string): void {
  const parsed = new URL(url);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new SecretSubstitutionError("secret_not_allowed_for_origin");
  }
}

function buildRedirectRequest(source: Request, url: URL, status: number): Request {
  const becomesGet =
    ((status === 301 || status === 302) && source.method === "POST") ||
    (status === 303 && source.method !== "GET" && source.method !== "HEAD");
  if (!becomesGet) return new Request(url, source);

  const headers = new Headers(source.headers);
  for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
  return new Request(url, {
    headers,
    method: "GET",
    redirect: "manual",
    signal: source.signal,
  });
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // The response is being discarded regardless; cancellation is best effort.
  }
}
