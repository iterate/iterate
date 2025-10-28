import { z } from "zod";

const IntegrationUserMap = z.object({
  integrationSlug: z.string(),
  externalUserId: z.string(),
  internalUserId: z.string().optional(),
  email: z.string().optional(),
  rawUserInfo: z.record(z.string(), z.unknown()).optional(),
});

export const Participant = z.object({
  internalUserId: z.string(),
  joinedAt: z.string().datetime(),
  lastActiveAt: z.string().datetime().optional(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  role: z.enum(["member", "admin", "owner", "guest", "external"]).optional(),
  externalUserMapping: z.record(z.string(), IntegrationUserMap).optional(),
});

export type Participant = z.infer<typeof Participant>;

export const ParticipantJoinedEvent = z.object({
  type: z.literal("CORE:PARTICIPANT_JOINED"),
  data: z.object({
    internalUserId: z.string(),
    email: z.string().optional(),
    displayName: z.string().optional(),
    externalUserMapping: z.record(z.string(), IntegrationUserMap).optional(),
  }),
});

export const ParticipantLeftEvent = z.object({
  type: z.literal("CORE:PARTICIPANT_LEFT"),
  data: z.object({
    internalUserId: z.string(),
  }),
});

export const ParticipantEvent = z.discriminatedUnion("type", [
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
]);

export type ParticipantEvent = z.infer<typeof ParticipantEvent>;
