import { createServerFn, getGlobalStartContext } from "@tanstack/react-start";

export type PublicRouteConfig = {
  baseUrl?: string;
  mcpBaseUrl?: string;
  projectHostnameBases: string[];
};

export const getPublicRouteConfig = createServerFn({ method: "GET" }).handler(
  (): PublicRouteConfig => {
    const config = getGlobalStartContext()?.config;

    return {
      baseUrl: config?.baseUrl,
      mcpBaseUrl: config?.mcp?.baseUrl,
      projectHostnameBases: config?.projectHostnameBases ?? [],
    };
  },
);
