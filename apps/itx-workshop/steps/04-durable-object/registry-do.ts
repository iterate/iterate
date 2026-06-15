// The simple registry Durable Object, shared by steps 04, 05, 06 (the
// pre-StreamProcessor tier). It's the Step-03 registry moved into a DO so it
// outlives any one connection and TWO clients can rendezvous on it — including on
// a LIVE capability one of them provided. (Step 07 upgrades this whole idea to a
// StreamProcessor over a durable event log; this DO is the simpler ancestor.)
//
// The worker exports this once; each of steps 04-06 mounts its own route over it.

import { DurableObject } from "cloudflare:workers";

// Retain a provided stub past the call return — Cap'n Web disposes argument stubs
// when the call that received them returns, so the bridge must keep its own copy.
export function retain(target: any): any {
  if (target && typeof target.dup === "function") return target.dup();
  if (target && typeof target === "object") {
    const out: any = Array.isArray(target) ? [] : {};
    for (const k of Object.keys(target)) out[k] = retain(target[k]);
    return out;
  }
  return target;
}

export class RegistryDO extends DurableObject {
  // The live bridge: name → stub. In-memory (a live cap dies with its provider),
  // but shared across every connection that meets this DO.
  #caps: Record<string, any> = {};

  provideCapability(name: string, capability: any): string {
    this.#caps[name] = retain(capability); // dup at the DO layer too
    return `provided ${name}`;
  }

  async invoke(name: string, args: unknown[]): Promise<unknown> {
    const cap = this.#caps[name];
    if (!cap) throw new Error(`no capability "${name}"`);
    return await cap(...(args ?? []));
  }

  list(): string[] {
    return Object.keys(this.#caps);
  }
}
