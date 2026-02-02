import type { OrganizationEventTypes } from "../outbox/event-types.ts";

export type OrganizationCreatedPayload = OrganizationEventTypes["organization:created"];

export async function handleOrganizationCreated(
  _payload: OrganizationCreatedPayload,
): Promise<void> {}
