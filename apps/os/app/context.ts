import { createContext } from "react-router";
import type { Variables } from "../backend/worker.ts";
import type { CloudflareEnv } from "../env.ts";

export type ReactRouterServerContext = {
  cloudflare: {
    env: CloudflareEnv;
    ctx: ExecutionContext;
  };
  variables: Variables;
};

export const ReactRouterServerContext = createContext<ReactRouterServerContext>();
