import { implement } from "@orpc/server";
import { codemodeContract } from "@iterate-com/codemode-contract";
import type { AppContext } from "~/context.ts";

export const os = implement(codemodeContract).$context<AppContext>();
