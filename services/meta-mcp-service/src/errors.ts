type MetaMcpErrorCode =
  | "INVALID_CONFIG"
  | "MISSING_BEARER_TOKEN"
  | "OAUTH_REQUIRED"
  | "OAUTH_AUTHORIZATION_NOT_STARTED"
  | "OAUTH_AUTHORIZATION_NOT_COMPLETED"
  | "OAUTH_MISSING_CODE_VERIFIER"
  | "UPSTREAM_TIMEOUT"
  | "SERVER_NOT_FOUND"
  | "TOOL_NOT_FOUND"
  | "NAMESPACE_CONFLICT";

export class MetaMcpError extends Error {
  constructor(
    readonly code: MetaMcpErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MetaMcpError";
  }
}

export function serializeError(error: unknown) {
  if (error instanceof MetaMcpError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      code: "ERROR",
      message: error.message,
      details: {},
    };
  }

  return {
    name: "Error",
    code: "ERROR",
    message: String(error),
    details: {},
  };
}
