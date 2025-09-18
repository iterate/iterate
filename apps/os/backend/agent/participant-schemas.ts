import { z } from "zod/v4";

// Integration user mapping schema (matches database structure)
const IntegrationUserMap = z.object({
  integrationSlug: z.string(),
  externalUserId: z.string(),
  internalUserId: z.string().optional(),
  email: z.string().optional(),
  rawUserInfo: z.record(z.string(), z.unknown()).optional(),
});

// Participant schema
export const Participant = z.object({
  internalUserId: z.string(),
  joinedAt: z.string().datetime(),
  lastActiveAt: z.string().datetime().optional(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  externalUserMapping: z.record(z.string(), IntegrationUserMap).optional(),
});

export type Participant = z.infer<typeof Participant>;

// Participant events
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

// Discriminated union of all participant events
export const ParticipantEvent = z.discriminatedUnion("type", [
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
]);

export type ParticipantEvent = z.infer<typeof ParticipantEvent>;
