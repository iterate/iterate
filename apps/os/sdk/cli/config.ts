import { initTRPC } from "@trpc/server";
import { type TrpcCliMeta } from "trpc-cli";

export const t = initTRPC.meta<TrpcCliMeta>().create();
