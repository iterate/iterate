import { implement } from "@orpc/server";
import { ingressProxyContract } from "@iterate-com/ingress-proxy-contract";
import type { AppContext } from "~/context.ts";

export const os = implement(ingressProxyContract).$context<AppContext>();
