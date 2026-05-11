import { implement } from "@orpc/server";
import { exampleContract } from "@iterate-com/example-contract";
import type { AppContext } from "~/context.ts";

export const os = implement(exampleContract).$context<AppContext>();
