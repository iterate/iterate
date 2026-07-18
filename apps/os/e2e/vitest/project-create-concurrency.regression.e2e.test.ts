import { test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test.fails(
  "DESIRED: concurrent creates of one slug adopt the same project identity",
  { retry: 0 },
  async ({ expect }) => {
    using session = withItxSession({
      auth: { type: "admin-secret", secret: adminSecret() },
    });
    const slug = `project-create-race-${crypto.randomUUID().slice(0, 8)}`;

    using first = session.projects.create({ slug, waitUntilReady: false });
    using second = session.projects.create({ slug, waitUntilReady: false });
    const [firstIdentity, secondIdentity] = await Promise.all([
      first.identity(),
      second.identity(),
    ]);

    expect(secondIdentity).toEqual(firstIdentity);
    expect(firstIdentity).toMatchObject({ organizationId: null, slug });
    await first.waitUntilReady();
  },
);
