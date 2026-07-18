/**
 * Attach headers emitted while authenticating a request to the response that
 * the relying party eventually returns.
 *
 * Session authentication can rotate a refresh token. The resulting
 * `Set-Cookie` is part of the authentication transaction: dropping it leaves
 * the browser on the spent token and causes a later reuse revocation. Build a
 * new response so this also works when the original response has an immutable
 * header guard (for example a response returned by another fetch handler).
 */
export function withAuthenticationResponseHeaders(
  response: Response,
  authenticationHeaders: Headers,
): Response {
  const headers = new Headers(response.headers);
  let changed = false;

  for (const [name, value] of authenticationHeaders) {
    if (name.toLowerCase() === "set-cookie") continue;
    headers.append(name, value);
    changed = true;
  }
  for (const cookie of authenticationHeaders.getSetCookie()) {
    headers.append("set-cookie", cookie);
    changed = true;
  }

  if (!changed) return response;
  if (response.status === 101) {
    throw new Error("authentication cannot rotate a cookie on a WebSocket response");
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
