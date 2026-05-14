// @ts-nocheck
import { appFetch } from "../../lib/sdk.ts";

export const fetch = appFetch("app1", () => new Response("hello from app one"));
