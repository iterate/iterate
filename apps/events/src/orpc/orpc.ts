import { implement } from "@orpc/server";
import { eventsContract } from "@iterate-com/events-contract";
import type { AppContext } from "~/context.ts";

export const os = implement(eventsContract).$context<AppContext>();
