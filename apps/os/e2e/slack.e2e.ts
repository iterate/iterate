import { expect, test, beforeAll, afterAll } from "vitest";
import {
  createDisposer,
  createTestHelper,
  getAuthedTrpcClient,
  startOpenAIFixtureServer,
} from "./helpers.ts";

let fixtureServerUrl: string;
let stopFixtureServer: () => Promise<void>;

beforeAll(async () => {
  const server = await startOpenAIFixtureServer();
  fixtureServerUrl = server.fixtureServerUrl;
  stopFixtureServer = server.stop;
});

afterAll(async () => {
  await stopFixtureServer();
});

test("slack agent", { timeout: 15 * 60 * 1000 }, async () => {
  const { client: adminTrpc, impersonate } = await getAuthedTrpcClient();
  await using disposer = createDisposer();

  const { user: testUser } = await adminTrpc.testing.createTestUser.mutate({});
  disposer.fns.push(async () => {
    await adminTrpc.admin.deleteUserByEmail.mutate({ email: testUser.email });
  });

  const { organization } = await adminTrpc.testing.createOrganizationAndEstate.mutate({
    userId: testUser.id,
  });
  disposer.fns.push(async () => {
    await adminTrpc.testing.deleteOrganization.mutate({ organizationId: organization.id });
  });

  const { trpcClient: userTrpc } = await impersonate(testUser.id);

  const h = await createTestHelper({
    inputSlug: "slack-e2e",
    trpcClient: userTrpc,
  });

  // Enable OpenAI record/replay for deterministic testing
  // By default uses 'replay' mode. Set OPENAI_RECORD_MODE=record to capture new fixtures.
  await h.enableOpenAIRecordReplay(fixtureServerUrl);

  const sent = await h.sendUserMessage("what is 1+2");
  const reply = await sent.waitForReply();
  expect(reply).toMatch(/3|three/i);
});
