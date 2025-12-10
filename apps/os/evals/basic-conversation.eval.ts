import {
  createTestHelper,
  getAuthedTrpcClient,
  multiTurnScorer,
  evaliterate,
  createDisposer,
} from "../e2e/helpers.ts";

evaliterate("agent knows when to end their turn", {
  trialCount: Number(process.env.EVAL_TRIAL_COUNT) || undefined,
  data: async () => {
    return [
      {
        input: {
          slug: "multi-turn-fruits-conversation",
          messages: [
            { message: "name a green fruit", expected: "a green fruit" },
            { message: "name another", expected: "a green fruit, not the same as the first" },
            {
              message: "name another",
              expected: "a green fruit, not the same as the 1st or 2nd",
            },
          ].map((m, i) => {
            m.expected += `. penalize emojis by ${10 + i * 5}%`;
            return m;
          }),
        },
      },
    ];
  },
  task: async ({ braintrustSpanExportedId, input }) => {
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
      inputSlug: "onboarding-e2e",
      trpcClient: userTrpc,
      braintrustSpanExportedId,
    });
    const scorer = multiTurnScorer({ braintrustSpanExportedId });

    for (const message of input.messages) {
      const userMessage = await h.sendUserMessage(message.message);
      const reply = await userMessage.waitForReply();

      scorer.scoreTurn([`user: ${message.message}`, `assistant: ${reply}`], message.expected);
    }

    return { scores: await scorer.getScores() };
  },
  scorers: [multiTurnScorer.meanOfMeansScorer],
  columns: multiTurnScorer.turnSummaryColumnRenderer,
});
