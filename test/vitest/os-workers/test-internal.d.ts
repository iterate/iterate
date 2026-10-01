/** @cloudflare/vitest-plugin's runtime module, part of which `cloudflare:test` re-exports. It keeps
 *  every `waitUntil` the worker's handlers register, and empty-runtime.ts awaits them. */
declare module "cloudflare:test-internal" {
  export function waitForGlobalWaitUntil(): Promise<void>;
}
