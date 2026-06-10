import { createServerFn } from "@tanstack/react-start";
import { requireRequestContext } from "~/request-context.ts";

export type PublicRouteConfig = {
  baseUrl?: string;
  mcpBaseUrl?: string;
  projectHostnameBases: string[];
};

export const getPublicRouteConfig = createServerFn({ method: "GET" }).handler(
  (): PublicRouteConfig => {
    const config = requireRequestContext().config;

    return {
      baseUrl: config.baseUrl,
      mcpBaseUrl: config.mcp?.baseUrl,
      projectHostnameBases: config.projectHostnameBases ?? [],
    };
  },
);
