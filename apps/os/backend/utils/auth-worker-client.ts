import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { env } from "../../env.ts";
import type { AuthContractClient } from "../../../auth-contract/src/index.ts";
import { PROJECT_INGRESS_AUTH_TOKEN_COOKIE } from "../auth/constants.ts";

const AUTH_WORKER_TIMEOUT_MS = 30_000;

export type AuthWorkerClient = AuthContractClient;

function getCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return rawValue.join("=") || null;
    }
  }
  return null;
}

export function buildAuthWorkerForwardHeaders(headers?: Headers): Headers {
  const forwarded = new Headers();
  const cookie = headers?.get("cookie");
  if (cookie) {
    forwarded.set("cookie", cookie);
  }

  const authorization = headers?.get("authorization");
  if (authorization) {
    forwarded.set("authorization", authorization);
    return forwarded;
  }

  if (cookie) {
    const ingressToken = getCookieValue(cookie, PROJECT_INGRESS_AUTH_TOKEN_COOKIE);
    if (ingressToken) {
      forwarded.set("authorization", `Bearer ${ingressToken}`);
    }
  }

  return forwarded;
}

export function createAuthWorkerClient(params: {
  headers?: Headers;
  serviceToken?: string;
  asUser?: { authUserId: string };
}): AuthWorkerClient {
  const baseHeaders = buildAuthWorkerForwardHeaders(params.headers);
  const serviceToken = params.serviceToken ?? env.SERVICE_AUTH_TOKEN;
  if (serviceToken) {
    baseHeaders.set("x-iterate-service-token", serviceToken);
  }
  if (params.asUser) {
    baseHeaders.set("x-iterate-as-user", params.asUser.authUserId);
  }

  const fetchWithTimeout: typeof globalThis.fetch = (input, init) => {
    const externalSignal = init?.signal;
    const timeoutSignal = AbortSignal.timeout(AUTH_WORKER_TIMEOUT_MS);
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;
    const headers = new Headers(init?.headers ?? undefined);
    baseHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
    return fetch(input, { ...init, headers, signal });
  };

  return createORPCClient(
    new RPCLink({
      url: new URL("/api/orpc", env.VITE_AUTH_APP_ORIGIN).toString(),
      fetch: fetchWithTimeout,
    }),
  );
}
