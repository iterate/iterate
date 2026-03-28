import { z } from "zod/v4";

export const ResendWebhookReceivedEventPayload = z.object({
  type: z.literal("email.received"),
  created_at: z.string(),
  data: z.object({
    email_id: z.string(),
    created_at: z.string(),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    message_id: z.string(),
    subject: z.string(),
    attachments: z.array(
      z.object({
        id: z.string(),
        filename: z.string(),
        content_type: z.string(),
        content_disposition: z.string(),
        content_id: z.string().optional(),
      }),
    ),
  }),
  _iterate_email_content: z
    .object({
      text: z.string(),
      html: z.string().nullable().optional(),
    })
    .optional(),
});

export type ResendWebhookReceivedEventPayload = z.infer<typeof ResendWebhookReceivedEventPayload>;

export const PosthogWebhookReceivedEventPayload = z.object({
  deliveryId: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export type PosthogWebhookReceivedEventPayload = z.infer<typeof PosthogWebhookReceivedEventPayload>;
