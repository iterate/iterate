import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { 
  uploadFileHandler, 
  uploadFileFromUrlHandler, 
  getFileHandler 
} from "../backend/file-handlers.ts";
import type { CloudflareEnv } from "env.ts";


declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: CloudflareEnv;
      ctx: ExecutionContext;
    };
  }
}

const app = new Hono<{ Bindings: CloudflareEnv }>();

const requestHandler = createRequestHandler(
  //@ts-expect-error - this is a virtual module
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

// File upload routes
app.use("/api/estate/:estateId/*", (_c, next) => {
  // TODO: Add auth here!
  return next();
})
app.post("/api/estate/:estateId/files", uploadFileHandler);
app.post("/api/estate/:estateId/files/from-url", uploadFileFromUrlHandler);
app.get("/api/estate/:estateId/files/:id", getFileHandler);

app.all("*", (c)=>{
  return requestHandler(c.req.raw, {
    cloudflare: { env: c.env, ctx: c.executionCtx },
  });
});

export default app;