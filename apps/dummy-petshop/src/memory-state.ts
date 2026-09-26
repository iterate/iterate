/**
 * The pet shop's Slack, Google, Cloudflare and GitHub fakes over in-memory state, for tests
 * that import them instead of dialing the deployed shop (apps/os's workers
 * tests). Seeded like the deployed shop: the OAuth client `petshop-default` /
 * `petshop-default-secret` and the keyless `petshop-installation`. Nothing
 * here or below imports `cloudflare:workers` or Node, so it runs in workerd
 * and in Node alike.
 */
import { handleGithubRequest } from "./github.ts";
import { handleGoogleRequest } from "./google.ts";
import { handleCloudflareRequest } from "./cloudflare.ts";
import { randomSealKey } from "./seal.ts";
import { handleSlackRequest } from "./slack.ts";
import { PetshopStore } from "./state.ts";

/**
 * `handle` answers a request at Slack's, Google's or GitHub's paths (null for
 * any other); `state` is the store behind it (`registerApp`,
 * `expireAccessTokens`, `getState`, …). Values are cloned in and out, as a
 * Durable Object's storage does.
 */
export function memoryPetshop(options: { sealKey?: string } = {}) {
  const blobs = new Map<string, unknown>();
  const state = new PetshopStore({
    get: async <T>(key: string) => structuredClone(blobs.get(key)) as T | undefined,
    put: async (key, value) => void blobs.set(key, structuredClone(value)),
  });
  const deps = { state, sealKey: options.sealKey || randomSealKey() };
  return {
    state,
    sealKey: deps.sealKey,
    handle: async (request: Request): Promise<Response | null> =>
      (await handleSlackRequest(request, deps)) ??
      (await handleGoogleRequest(request, deps)) ??
      (await handleCloudflareRequest(request, deps)) ??
      (await handleGithubRequest(request, deps)),
  };
}
