import { implement } from "@orpc/server";
import { agentsContract } from "@iterate-com/agents-contract";
import type { AppContext } from "~/context.ts";

export const os = implement(agentsContract).$context<AppContext>();
