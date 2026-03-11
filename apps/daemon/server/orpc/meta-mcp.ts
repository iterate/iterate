import { z } from "zod/v4";
import { ORPCError } from "@orpc/server";
import { publicProcedure } from "./init.ts";

const META_MCP_SERVICE_BASE_URL = process.env.META_MCP_SERVICE_BASE_URL ?? "http://127.0.0.1:19070";

const serializedErrorSchema = z.object({
  name: z.string(),
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
});

const metaMcpStatusSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    publicBaseUrl: z.string().url(),
    publicBaseUrlIsPlaceholder: z.boolean(),
    configPath: z.string(),
    authPath: z.string(),
    servers: z.array(
      z.object({
        id: z.string(),
        namespace: z.string().nullable(),
        url: z.string().url(),
        transport: z.enum(["streamable-http", "auto"]),
        enabled: z.boolean(),
        toolCount: z.number().int().nonnegative(),
        error: z.string().optional(),
        auth: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("none"),
          }),
          z.object({
            type: z.literal("auto"),
            oauthConnected: z.boolean(),
            expiresAt: z.string().nullable(),
            callbackUrl: z.string().url(),
          }),
          z.object({
            type: z.literal("bearer"),
            env: z.string(),
            configured: z.boolean(),
          }),
          z.object({
            type: z.literal("oauth"),
            connected: z.boolean(),
            expiresAt: z.string().nullable(),
            callbackUrl: z.string().url(),
          }),
        ]),
      }),
    ),
  }),
  z.object({
    ok: z.literal(false),
    publicBaseUrl: z.string().url(),
    publicBaseUrlIsPlaceholder: z.boolean(),
    configPath: z.string(),
    authPath: z.string(),
    error: serializedErrorSchema,
  }),
]);

const metaMcpStartOAuthSchema = z.object({
  serverId: z.string(),
  authUrl: z.string(),
  callbackUrl: z.string().url(),
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
    return metaMcpStatusSchema.parse(await requestMetaMcp("/api/status"));
  }),

  startOAuth: publicProcedure
    .input(
      z.object({
        serverId: z.string().min(1),
      }),
    )
    .handler(async ({ input }) => {
      return metaMcpStartOAuthSchema.parse(
        await requestMetaMcp("/api/oauth/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        }),
      );
    }),
};
