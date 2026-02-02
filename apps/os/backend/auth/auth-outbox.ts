import { env } from "../../env.ts";
import { captureServerEvent } from "../lib/posthog.ts";
import type { UserEventTypes } from "../outbox/event-types.ts";

export type UserCreatedPayload = UserEventTypes["user:created"];

export async function handleUserCreated(payload: UserCreatedPayload): Promise<void> {
  const personProperties: Record<string, unknown> = { email: payload.email };

  if (payload.name) {
    personProperties.name = payload.name;
  }

  await captureServerEvent(env, {
    distinctId: payload.userId,
    event: "user_signed_up",
    properties: {
      signup_method: payload.signupMethod ?? "oauth",
      $set: personProperties,
    },
  });

  await maybeSendWelcomeEmail(payload);
  await maybeCreateDefaultOrganization(payload);
}

// Hook: welcome email sending.
async function maybeSendWelcomeEmail(_payload: UserCreatedPayload): Promise<void> {}

// Hook: default organization creation.
async function maybeCreateDefaultOrganization(_payload: UserCreatedPayload): Promise<void> {}
