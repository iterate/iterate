const AUTHORIZATION_RESPONSE_ISS_SUPPORT = "authorization_response_iss_parameter_supported";

/**
 * Codex 0.144.3 drops `iss` while forwarding its OAuth callback to RMCP. If
 * discovery advertises RFC 9207 support, RMCP consequently rejects an otherwise
 * valid callback as missing its issuer. Keep emitting `iss` in authorization
 * responses, but do not advertise it as mandatory until that client handoff is
 * fixed.
 */
export async function makeAuthorizationResponseIssuerOptional(
  response: Response,
): Promise<Response> {
  const metadata = (await response.json()) as Record<string, unknown>;
  delete metadata[AUTHORIZATION_RESPONSE_ISS_SUPPORT];

  const headers = new Headers(response.headers);
  headers.delete("content-length");

  return Response.json(metadata, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
