import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { router, projectProtectedMutation, projectProtectedProcedure } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import {
  forwardWebChatWebhookToMachine,
  listWebChatMessagesFromMachine,
  listWebChatThreadsFromMachine,
} from "../../integrations/web-chat/web-chat.ts";

const AttachmentInput = z.object({
  fileName: z.string(),
  filePath: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
});

const SendMessageInput = z.object({
  threadId: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().max(50_000).optional().default(""),
  messageId: z.string().trim().min(1).max(200).optional(),
  attachments: z.array(AttachmentInput).optional(),
});

const GetThreadMessagesInput = z.object({
  threadId: z.string().trim().min(1).max(200).optional(),
});

export const webChatRouter = router({
  listThreads: projectProtectedProcedure.query(async ({ ctx }) => {
    const machine = await ctx.db.query.machine.findFirst({
      where: and(eq(schema.machine.projectId, ctx.project.id), eq(schema.machine.state, "active")),
    });

    if (!machine) {
      return { threads: [] };
    }

    const response = await listWebChatThreadsFromMachine(machine, ctx.env);
    if (!response.success) {
      throw new TRPCError({ code: "BAD_GATEWAY", message: response.error });
    }

    return response.data;
  }),

  getThreadMessages: projectProtectedProcedure
    .input(z.object({ projectSlug: z.string(), ...GetThreadMessagesInput.shape }))
    .query(async ({ ctx, input }) => {
      if (!input.threadId) {
        return { threadId: "", messages: [] };
      }

      const machine = await ctx.db.query.machine.findFirst({
        where: and(
          eq(schema.machine.projectId, ctx.project.id),
          eq(schema.machine.state, "active"),
        ),
      });

      if (!machine) {
        return { threadId: input.threadId, messages: [] };
      }

      const response = await listWebChatMessagesFromMachine(machine, input.threadId, ctx.env);
      if (!response.success) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: response.error,
        });
      }

      return response.data;
    }),

  sendMessage: projectProtectedMutation
    .input(z.object({ projectSlug: z.string(), ...SendMessageInput.shape }))
    .mutation(async ({ ctx, input }) => {
      const machine = await ctx.db.query.machine.findFirst({
        where: and(
          eq(schema.machine.projectId, ctx.project.id),
          eq(schema.machine.state, "active"),
        ),
      });

      if (!machine) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No active machine for this project. Create or start a machine first.",
        });
      }

      const payload = {
        type: "web-chat:message",
        threadId: input.threadId,
        messageId: input.messageId ?? crypto.randomUUID(),
        text: input.text,
        userId: ctx.user.id,
        userName: ctx.user.name ?? ctx.user.email,
        projectId: ctx.project.id,
        projectSlug: ctx.project.slug,
        attachments: input.attachments,
        createdAt: Date.now(),
      } satisfies Record<string, unknown>;

      const response = await forwardWebChatWebhookToMachine(machine, payload, ctx.env);
      if (!response.success) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: response.error,
        });
      }

      return response.data;
    }),
});
