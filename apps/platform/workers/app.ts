import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import {
  uploadFileHandler,
  uploadFileFromUrlHandler,
  getFileHandler,
} from "../backend/file-handlers.ts";
import type { CloudflareEnv } from "../env.ts";
import { auth } from "../backend/auth/auth.ts";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: CloudflareEnv;
      ctx: ExecutionContext;
    };
  }
}
export type Variables = {
  session: typeof auth.$Infer.Session | null;
};

const app = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

app.use("*", async (c, next) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  c.set("session", session);
  return next();
});

app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

// File upload routes
app.use("/api/estate/:estateId/*", (c, next) => {
  if (!c.var.session) c.json({ error: "Unauthorized" }, 401);
  //TODO: session.user.estates.includes(c.req.param("estateId")) -> PASS
  return next();
});

app.post("/api/estate/:estateId/files", uploadFileHandler);
app.post("/api/estate/:estateId/files/from-url", uploadFileFromUrlHandler);
app.get("/api/estate/:estateId/files/:id", getFileHandler);

const requestHandler = createRequestHandler(
  //@ts-expect-error - this is a virtual module
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

app.all("*", (c) => {
  return requestHandler(c.req.raw, {
    cloudflare: { env: c.env, ctx: c.executionCtx },
  });
});

export default app;
