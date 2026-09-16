import { createIterateClient } from "iterate/next/app";

export const iterate = createIterateClient({ scopes: ["iterate", "account"] });
