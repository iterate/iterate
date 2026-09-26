import { DurableObject } from "cloudflare:workers";
import { PetshopStore } from "./state.ts";

/**
 * The one Durable Object behind the whole app (named "global"): the shop's
 * state (state.ts `PetshopStore`) over its storage. Its input gate serializes
 * the store's load → mutate → save methods, which the worker calls over RPC.
 */
export class PetshopStateDurableObject extends DurableObject {
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
