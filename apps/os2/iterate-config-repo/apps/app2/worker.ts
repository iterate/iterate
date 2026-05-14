// @ts-nocheck
import { appFetch } from "../../lib/sdk.ts";

export const fetch = appFetch("app2", () => new Response("hello from app two"));
