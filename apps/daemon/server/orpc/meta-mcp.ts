import { z } from "zod/v4";
import { ORPCError } from "@orpc/server";
import { publicProcedure } from "./init.ts";

const META_MCP_SERVICE_BASE_URL = process.env.META_MCP_SERVICE_BASE_URL ?? "http://127.0.0.1:19070";

const MetaMcpStatus = z.object({
  publicBaseUrl: z.string().url(),
  servers: z.array(
    z.object({
      id: z.string(),
      namespace: z.string().nullable(),
      url: z.string().url(),
      enabled: z.boolean(),
      auth: z.object({
        type: z.enum(["none", "bearer", "auto", "oauth"]),
        connected: z.boolean(),
      }),
    }),
  ),
});

const MetaMcpOAuthStart = z.object({
  stateIdentifier: z.string(),
  serverId: z.string(),
  expiresAt: z.string(),
  authenticationUrl: z.string(),
});

async function requestMetaMcp(path: string, init?: RequestInit) {
  let response: Response;

  try {
    response = await fetch(`${META_MCP_SERVICE_BASE_URL}${path}`, init);
  } catch (error) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: `Meta MCP service unavailable at ${META_MCP_SERVICE_BASE_URL}`,
      cause: error,
    });
  }

  const text = await response.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: `Meta MCP returned invalid JSON (status ${response.status})`,
      });
    }
  }

  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string"
        ? data.message
        : `Meta MCP request failed with ${response.status}`;

    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message,
      cause: data,
    });
  }

  return data;
}

export const metaMcpOrpcRouter = {
  getStatus: publicProcedure.handler(async () => {
    return MetaMcpStatus.parse(await requestMetaMcp("/api/status"));
  }),
  startOAuth: publicProcedure
    .input(z.object({ serverId: z.string() }))
    .handler(async ({ input }) => {
      return MetaMcpOAuthStart.parse(
        await requestMetaMcp(`/api/oauth/start/${input.serverId}`, { method: "POST" }),
      );
    }),
};
