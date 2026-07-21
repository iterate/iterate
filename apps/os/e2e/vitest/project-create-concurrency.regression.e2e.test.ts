import { test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test.fails(
  "DESIRED: concurrent creates of one slug adopt the same project identity",
  { retry: 0 },
  async ({ expect }) => {
    using session = withItxSession({
      auth: { type: "admin-secret", secret: adminSecret() },
      generateProjectIds: false,
    });
    const slug = `project-create-race-${crypto.randomUUID().slice(0, 8)}`;

    // Deliberately retain the two pipelined promises here: awaiting the first
    // create before issuing the second would no longer exercise the race.
    using first = session.projects.get(slug).create({});
    using second = session.projects.get(slug).create({});
    const [firstIdentity, secondIdentity] = await Promise.all([
      first.identity(),
      second.identity(),
    ]);

    expect(secondIdentity).toEqual(firstIdentity);
    expect(firstIdentity).toMatchObject({ organizationId: null, slug });
    await first.waitUntilReady();
  },
);
