import { and, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import {
  projectProtectedMutation,
  projectProtectedProcedure,
  ProjectInput,
} from "../procedures.ts";
import * as schema from "../../db/schema.ts";
import {
  forwardWebchatWebhookToMachine,
  listWebchatMessagesFromMachine,
  listWebchatThreadsFromMachine,
} from "../../integrations/webchat/webchat.ts";

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

export const webchatRouter = {
  listThreads: projectProtectedProcedure.input(ProjectInput).handler(async ({ context: ctx }) => {
    const machine = await ctx.db.query.machine.findFirst({
      where: and(eq(schema.machine.projectId, ctx.project.id), eq(schema.machine.state, "active")),
    });

    if (!machine) {
      return { threads: [] };
    }

    const response = await listWebchatThreadsFromMachine(machine, ctx.env);
    if (!response.success) {
      throw new ORPCError("BAD_GATEWAY", { message: response.error });
    }

    return response.data;
  }),

  getThreadMessages: projectProtectedProcedure
    .input(z.object({ projectSlug: z.string(), ...GetThreadMessagesInput.shape }))
    .handler(async ({ context: ctx, input }) => {
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

      const response = await listWebchatMessagesFromMachine(machine, input.threadId, ctx.env);
      if (!response.success) {
        throw new ORPCError("BAD_GATEWAY", { message: response.error });
      }

      return response.data;
    }),

  sendMessage: projectProtectedMutation
    .input(z.object({ projectSlug: z.string(), ...SendMessageInput.shape }))
    .handler(async ({ context: ctx, input }) => {
      const machine = await ctx.db.query.machine.findFirst({
        where: and(
          eq(schema.machine.projectId, ctx.project.id),
          eq(schema.machine.state, "active"),
        ),
      });

      if (!machine) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: "No active machine for this project. Create or start a machine first.",
        });
      }

      const payload = {
        type: "webchat:message",
        threadId: input.threadId,
        messageId: input.messageId ?? crypto.randomUUID(),
        text: input.text,
        userId: ctx.user.id,
        userName: ctx.user.name || ctx.user.email,
        projectId: ctx.project.id,
        projectSlug: ctx.project.slug,
        attachments: input.attachments,
        createdAt: Date.now(),
      } satisfies Record<string, unknown>;

      const response = await forwardWebchatWebhookToMachine(machine, payload, ctx.env);
      if (!response.success) {
        throw new ORPCError("BAD_GATEWAY", { message: response.error });
      }

      return response.data;
    }),
};
