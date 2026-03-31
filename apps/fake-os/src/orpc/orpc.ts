import { implement } from "@orpc/server";
import { fakeOsAppContract } from "@iterate-com/fake-os-contract";
import type { AppContext } from "~/context.ts";

export const os = implement(fakeOsAppContract).$context<AppContext>();
