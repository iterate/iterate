export function verifyBearerAuth(request: Request, expectedToken?: string): Response | null {
  if (!expectedToken) return null;
  const authHeader =
    request.headers.get("authorization") ?? request.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!token || token !== expectedToken) {
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        message: "Missing or invalid Bearer token",
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="Mock MCP", error="invalid_token"',
        },
      },
    );
  }
  return null;
}

export function verifyBearerHeaderPresent(request: Request): Response | null {
  const authHeader =
    request.headers.get("authorization") ?? request.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!token) {
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        message: "Missing Bearer token",
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="Mock MCP", error="invalid_token"',
        },
      },
    );
  }
  return null;
}
