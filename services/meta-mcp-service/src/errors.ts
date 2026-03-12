import { inspect } from "node:util";

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

export type SerializedError = {
  type: "serialized_error";
  name: string;
  code: string;
  message: string;
  details: Record<string, unknown>;
};

export function serializeError(error: unknown): SerializedError {
  if (error instanceof MetaMcpError) {
    return {
      type: "serialized_error",
      name: error.name,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      type: "serialized_error",
      name: error.name,
      code: "ERROR",
      message: inspect(error, { depth: 8, breakLength: 120 }),
      details: {},
    };
  }

  return {
    type: "serialized_error",
    name: "Error",
    code: "ERROR",
    message: inspect(error, { depth: 8, breakLength: 120 }),
    details: {},
  };
}
