import { implement } from "@orpc/server";
import { osContract } from "@iterate-com/os2-contract";
import type { AppContext } from "~/context.ts";

export const os = implement(osContract).$context<AppContext>();
