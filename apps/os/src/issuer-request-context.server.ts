import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env.ts";

/** One issuer request as Start sees it: the Worker's bindings and context, the CSP nonce of its
 *  response, and whether a server function's input decoded (src/start.ts). */
interface IssuerRequest {
  env: Env;
  ctx: ExecutionContext;
  nonce: string;
  serverFunctionInputDecoded: boolean;
}

const issuerRequests = new AsyncLocalStorage<IssuerRequest>();

export function withIssuerRequest<T>(
  env: Env,
  ctx: ExecutionContext,
  nonce: string,
  render: () => T,
): T {
  return issuerRequests.run({ env, ctx, nonce, serverFunctionInputDecoded: false }, render);
}

export function issuerRequestContext() {
  const context = issuerRequests.getStore();
  if (!context) throw new Error("Issuer page rendered outside the OS Next Worker");
  return context;
}

export function issuerRequestNonce() {
  return issuerRequestContext().nonce;
}
