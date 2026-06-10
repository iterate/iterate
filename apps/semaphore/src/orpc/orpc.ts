import { implement } from "@orpc/server";
import { semaphoreContract } from "@iterate-com/semaphore-contract";
import type { RequestContext } from "~/request-context.ts";

export const os = implement(semaphoreContract).$context<RequestContext>();
