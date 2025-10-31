import { eq } from "drizzle-orm";
import z from "zod";
import { t } from "../config.ts";
import { createDb } from "../cli-db.ts";
import * as schema from "../../../backend/db/schema.ts";

export async function addSuperAdminUser(connectionString: string) {
  const db = createDb(connectionString);

  const user = await db.query.user.findFirst({
    where: eq(schema.user.email, "admin-npc@nustom.com"),
  });

  if (user) {
    console.log("Super admin user already exists");
    return;
  }

  await db.insert(schema.user).values({
    email: "admin-npc@nustom.com",
    name: "Super Admin",
    role: "admin",
    emailVerified: true,
    debugMode: true,
  });

  console.log("Super admin user created");
  await db.$client.end();
}

const addSuperAdminUserToDb = t.procedure
  .input(
    z.object({
      connectionString: z.string().optional().describe("Connection string to the database"),
    }),
  )
  .mutation(async ({ input }) => {
    if (!input.connectionString) {
      console.log("No connection string provided, using local database");
      input.connectionString = `postgres://postgres:postgres@localhost:5432/iterate`;
    }
    return await addSuperAdminUser(input.connectionString);
  });

export const adminRouter = t.router({
  addSuperAdminUserToDb,
});
