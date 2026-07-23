import type { TasksCheckoutDurableObject } from "./checkout-do.ts";
import type { TasksCheckoutIndexDurableObject } from "./checkout-index-do.ts";

/** Worker + DO bindings (wrangler.jsonc declares exactly these). No secrets
 * — auth is the per-connection session token, proven by use against os. */
export type AppEnv = {
  CHECKOUT: DurableObjectNamespace<TasksCheckoutDurableObject>;
  INDEX: DurableObjectNamespace<TasksCheckoutIndexDurableObject>;
  OS_BASE_URL: string;
};
