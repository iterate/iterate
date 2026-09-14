import { createIterateClient } from "../client/browser.ts";

export const iterate = createIterateClient({ scopes: ["iterate", "account"] });
