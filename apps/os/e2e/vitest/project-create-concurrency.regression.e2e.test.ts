import { interceptor } from "@iterate-com/test-support";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

createFailing(test, /CONCURRENT CREATE SPLITS IDENTITY/)(
  "DESIRED: concurrent creates of one slug adopt the same project identity",
  { retry: 0 },
  async ({ expect }) => {
    using session = withItxSession({
      auth: { type: "admin-secret", secret: adminSecret() },
    });
    const slug = `project-create-race-${crypto.randomUUID().slice(0, 8)}`;

    // Deliberately retain the two pipelined promises here: awaiting the first
    // create before issuing the second would no longer exercise the race.
    using first = session.projects.get(slug).create({}, { waitUntilCreated: false });
    using second = session.projects.get(slug).create({}, { waitUntilCreated: false });
    const [firstIdentity, secondIdentity] = await Promise.all([
      first.identity(),
      second.identity(),
    ]);

    // Registration still races; configure each returned identity before onboarding.
    await Promise.all(
      [first, second].map(async (project) => interceptor.configureOnboarding(await project)),
    );

    expect(secondIdentity, "CONCURRENT CREATE SPLITS IDENTITY").toEqual(firstIdentity);
    expect(firstIdentity).toMatchObject({ organizationId: null, slug });
    await first.waitUntilCreated();
  },
);
