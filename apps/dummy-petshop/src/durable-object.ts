import { DurableObject } from "cloudflare:workers";
import { PetshopStore } from "./state.ts";
import type { Env } from "./worker.ts";

/**
 * The one object's name. It is created in ENAM (`locationHint`, which only takes effect when an
 * object is created), beside the callers that make nearly all its calls: CI runners in AWS
 * us-east-1, which reach Cloudflare at IAD, and the preview Workers at IAD and EWR. From there a
 * call to an object in Europe crosses the Atlantic twice. A new object starts from the seed
 * (state.ts `PetshopStore`).
 */
export const PETSHOP_STATE_NAME = "enam";

/**
 * The one Durable Object behind the whole app (named {@link PETSHOP_STATE_NAME}): the shop's state
 * (state.ts `PetshopStore`) over its storage. Its input gate serializes the store's load → mutate →
 * save methods, which the worker calls over RPC.
 */
export class PetshopStateDurableObject extends DurableObject<Env> {
  readonly #store = new PetshopStore(this.ctx.storage);

  getState() {
    return this.#store.getState();
  }
  createClient(...args: Parameters<PetshopStore["createClient"]>) {
    return this.#store.createClient(...args);
  }
  expireAccessTokens(...args: Parameters<PetshopStore["expireAccessTokens"]>) {
    return this.#store.expireAccessTokens(...args);
  }
  revokeToken(...args: Parameters<PetshopStore["revokeToken"]>) {
    return this.#store.revokeToken(...args);
  }
  consumeAuthorizationCode(...args: Parameters<PetshopStore["consumeAuthorizationCode"]>) {
    return this.#store.consumeAuthorizationCode(...args);
  }
  registerApp(...args: Parameters<PetshopStore["registerApp"]>) {
    return this.#store.registerApp(...args);
  }
  recordGithubPull(...args: Parameters<PetshopStore["recordGithubPull"]>) {
    return this.#store.recordGithubPull(...args);
  }
  recordGithubCheckRun(...args: Parameters<PetshopStore["recordGithubCheckRun"]>) {
    return this.#store.recordGithubCheckRun(...args);
  }
  oidcSigningKey() {
    return this.#store.oidcSigningKey();
  }
  recordSlackMessage(...args: Parameters<PetshopStore["recordSlackMessage"]>) {
    return this.#store.recordSlackMessage(...args);
  }
  setTokenEndpointFailures(...args: Parameters<PetshopStore["setTokenEndpointFailures"]>) {
    return this.#store.setTokenEndpointFailures(...args);
  }
  consumeTokenEndpointFailure(...args: Parameters<PetshopStore["consumeTokenEndpointFailure"]>) {
    return this.#store.consumeTokenEndpointFailure(...args);
  }
}
