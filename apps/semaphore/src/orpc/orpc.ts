import { implement } from "@orpc/server";
import { semaphoreContract } from "@iterate-com/semaphore-contract";
import type { AppContext } from "~/context.ts";

export const os = implement(semaphoreContract).$context<AppContext>();
