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

export const issuerRequests = new AsyncLocalStorage<IssuerRequest>();

export function issuerRequestContext() {
  const context = issuerRequests.getStore();
  if (!context) throw new Error("Issuer page rendered outside the OS worker");
  return context;
}
