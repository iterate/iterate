// @ts-nocheck
/* eslint-disable */
/**
 * Legacy oRPC e2e reference.
 *
 * This file intentionally is NOT named `.test.ts`.
 * Vitest discovers and executes `.test.ts` files under `apps/os/e2e/vitest`,
 * and this code imports the removed oRPC stack. It is preserved only as
 * reference material for porting Misha's original e2e coverage to ITX.
 */

import { expect, test } from "vitest";
import type { Event } from "@iterate-com/shared/streams/types";
import { createTestProject } from "../test-support/create-test-project.orpc-legacy.ts";
import { streamProjectEventsUntil } from "../test-support/os-client.orpc-legacy.ts";

test("creates a disposable project and uses project streams through oRPC", async () => {
  await using handle = await createTestProject({ slugPrefix: "admin-fixture" });

  const found = await handle.client.projects.find({ id: handle.project.id });

  expect(found).toMatchObject({
    id: handle.project.id,
    slug: handle.project.slug,
  });

  const streamPath = `/e2e/admin-project/${crypto.randomUUID()}`;
  const eventType = "events.iterate.com/os/e2e-admin-stream-proof";
  const marker = crypto.randomUUID();

  const created = await handle.client.project.streams.create({
    projectSlugOrId: handle.project.slug,
    streamPath,
  });

  expect(created).toMatchObject({
    namespace: handle.project.id,
    path: streamPath,
  });

  const streamed = streamProjectEventsUntil({
    afterOffset: "start",
    client: handle.client,
    projectSlugOrId: handle.project.slug,
    streamPath,
    predicate: (event): event is Event =>
      event.type === eventType && (event.payload as { marker?: unknown }).marker === marker,
    timeoutMs: 10_000,
  });

  const appended = await handle.client.project.streams.append({
    projectSlugOrId: handle.project.slug,
    streamPath,
    event: {
      type: eventType,
      payload: { marker },
    },
  });

  expect(appended.event).toMatchObject({
    offset: expect.any(Number),
    payload: { marker },
    type: eventType,
  });

  const read = await handle.client.project.streams.read({
    afterOffset: "start",
    projectSlugOrId: handle.project.slug,
    streamPath,
  });

  expect(read.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        offset: appended.event.offset,
        payload: { marker },
        type: eventType,
      }),
    ]),
  );

  await expect(streamed).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        offset: appended.event.offset,
        payload: { marker },
        type: eventType,
      }),
    ]),
  );
});
