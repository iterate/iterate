import { implement } from "@orpc/server";
import { daemonV2Contract } from "@iterate-com/daemon-v2-contract";
import type { AppContext } from "~/context.ts";

export const os = implement(daemonV2Contract).$context<AppContext>();
