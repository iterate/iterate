import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env.ts";

const issuerRequests = new AsyncLocalStorage<{ env: Env; ctx: ExecutionContext; nonce: string }>();

export function withIssuerRequest<T>(
  env: Env,
  ctx: ExecutionContext,
  nonce: string,
  render: () => T,
): T {
  return issuerRequests.run({ env, ctx, nonce }, render);
}

export function issuerRequestContext() {
  const context = issuerRequests.getStore();
  if (!context) throw new Error("Issuer page rendered outside the OS Next Worker");
  return context;
}

export function issuerRequestNonce() {
  return issuerRequestContext().nonce;
}
