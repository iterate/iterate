import { getAuth } from "../auth/auth.ts";
import { getDb } from "../db/client.ts";
import { appRouter } from "./root.ts";

export const createTrpcCaller = (headers?: Headers) =>
  appRouter.createCaller(async () => {
    const db = getDb();
    const auth = getAuth(db);
    const session = headers
      ? await auth.api.getSession({
          headers,
        })
      : null;
    return {
      db,
      session,
      user: session?.user || null,
    };
  });
