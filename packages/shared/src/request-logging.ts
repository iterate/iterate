import { createRequestLogger as createEvlogRequestLogger, type RequestLogger } from "evlog";

type RequestLogFields = Record<string, unknown>;

export type SharedRequestLogger = RequestLogger<RequestLogFields>;

export function createRequestLogger(options: {
  method?: string;
  path?: string;
  requestId?: string;
}): SharedRequestLogger {
  return createEvlogRequestLogger<RequestLogFields>(options);
}

export function getRequestIdHeader(value: string | string[] | null | undefined) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value[0]) return value[0];
  return undefined;
}
