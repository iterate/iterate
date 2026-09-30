// context-birth-events.ts — pure, so scripts that run before a build (the Vite config's
// scripts/generate-wrangler-config.ts) and the tests import it as they are.

/** THE EVENTS EVERY PROJECT CONTEXT IS BORN WITH, in every deployment (a change reaches the contexts
 *  born after it). `config` is spelled at the fixed point (`itx.builtins`) so no rule of the context's
 *  own can mask or re-point it. It delivers every durable event to the project's published config
 *  entrypoint, `itx.config` on `/` (./publication.ts), and passes over what is committed while none
 *  is published. */
export const PROJECT_CONTEXT_BIRTH_EVENTS = [
  {
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "config",
      target: "itx.builtins.cd('/').config.deliverEvent",
      delivery: "durable",
      afterOffset: 0,
      ordered: false,
    },
  },
] as const;
