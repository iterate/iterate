import { z } from "zod/v4";
import { and, eq, isNull } from "drizzle-orm";
import { typeid } from "typeid-js";
import { ORPCError, projectProtectedProcedure, withProjectMutationInput } from "../trpc.ts";
import { projectAccessToken } from "../../db/schema.ts";
import { encrypt } from "../../utils/encryption.ts";
import { generateProjectAccessKey } from "./machine.ts";

export const accessTokenRouter = {
  list: projectProtectedProcedure.handler(async ({ context }) => {
    const tokens = await context.db.query.projectAccessToken.findMany({
      where: eq(projectAccessToken.projectId, context.project.id),
      orderBy: (token, { desc }) => [desc(token.createdAt)],
    });

    return tokens.map((t) => ({
      id: t.id,
      name: t.name,
      lastUsedAt: t.lastUsedAt,
      revokedAt: t.revokedAt,
      createdAt: t.createdAt,
    }));
  }),

  create: withProjectMutationInput({
    name: z.string().min(1).max(100),
  }).handler(async ({ context, input }) => {
    const tokenId = typeid("pat").toString();
    const rawToken = generateProjectAccessKey(tokenId);
    const encryptedToken = await encrypt(rawToken);

    const [created] = await context.db
      .insert(projectAccessToken)
      .values({
        id: tokenId,
        projectId: context.project.id,
        name: input.name,
        encryptedToken,
      })
      .returning();

    if (!created) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Failed to create access token",
      });
    }

    return {
      id: created.id,
      name: created.name,
      token: rawToken,
      createdAt: created.createdAt,
    };
  }),

  revoke: withProjectMutationInput({
    id: z.string(),
  }).handler(async ({ context, input }) => {
    const existing = await context.db.query.projectAccessToken.findFirst({
      where: and(
        eq(projectAccessToken.id, input.id),
        eq(projectAccessToken.projectId, context.project.id),
        isNull(projectAccessToken.revokedAt),
      ),
    });

    if (!existing) {
      throw new ORPCError("NOT_FOUND", {
        message: "Access token not found or already revoked",
      });
    }

    const [revoked] = await context.db
      .update(projectAccessToken)
      .set({ revokedAt: new Date() })
      .where(eq(projectAccessToken.id, input.id))
      .returning();

    return {
      id: revoked.id,
      name: revoked.name,
      revokedAt: revoked.revokedAt,
    };
  }),
};
