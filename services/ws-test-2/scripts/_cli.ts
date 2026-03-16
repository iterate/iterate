import { os as osBase } from "@orpc/server";
import type { TrpcCliMeta } from "trpc-cli";

export const cliBase = osBase.$meta<TrpcCliMeta>({});
