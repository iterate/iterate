import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { auth, type AuthSession } from "../auth.ts";
import { db, type DB } from "../db/index.ts";
import type { CloudflareEnv } from "../env.ts";

export type Variables = {
  db: DB;
  session: AuthSession;
};

export const hono = () => new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

export const variablesProvider = () =>
  createMiddleware<{
    Variables: Variables;
    Bindings: CloudflareEnv;
  }>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("session", session);
    c.set("db", db);
    return next();
  });
