import { implement } from "@orpc/server";
import { semaphoreContract } from "~/contract.ts";
import type { RequestContext } from "~/request-context.ts";

export const semaphore = implement(semaphoreContract).$context<RequestContext>();
