import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { evaluateContextRuleMatchers, matchers, type ContextRule } from "./context.ts";

describe("evaluateContextRuleMatchers", () => {
  const cases = [
    {
      description: "[no-matchers] omitted -> true",
      state: {},
      matchers: undefined,
      expected: true,
    },
    {
      description: "[no-matchers] empty -> false",
      state: {},
      matchers: [],
      expected: false,
    },

    {
      description: "[single] always -> true",
      state: {},
      matchers: [matchers.always()],
      expected: true,
    },
    {
      description: "[single] never -> false",
      state: {},
      matchers: [matchers.never()],
      expected: false,
    },

    {
      description: "[multiple] any matcher matches via jsonata -> true",
      state: { paused: true },
      matchers: [matchers.never(), matchers.jsonata("agentCoreState.paused"), matchers.never()],
      expected: true,
    },
    {
      description: "[multiple] always short-circuits -> true",
      state: {},
      matchers: [matchers.never(), matchers.never(), matchers.always(), matchers.never()],
      expected: true,
    },
    {
      description: "[multiple] none match -> false",
      state: {},
      matchers: [
        matchers.never(),
        matchers.jsonata("$exists(agentCoreState.nonexistent)"),
        matchers.jsonata("$exists(agentCoreState.alsoNonexistent)"),
      ],
      expected: false,
    },

    {
      description: "[jsonata] boolean property true",
      state: { paused: true },
      matchers: [matchers.jsonata("agentCoreState.paused")],
      expected: true,
    },

    {
      description: "[jsonata] nested string property exists",
      state: { modelOpts: { model: "gpt-4o-mini" } },
      matchers: [matchers.jsonata("$exists(agentCoreState.modelOpts.model)")],
      expected: true,
    },
    {
      description: "[jsonata] array elements exist",
      state: {
        toolSpecs: [
          {
            type: "serialized_callable_tool",
            callable: {
              $infer: { Input: {}, Output: {} },
              type: "NOOP",
              passThroughArgs: null,
            },
          },
        ],
      },
      matchers: [matchers.jsonata("$length(agentCoreState.toolSpecs[*].type) > 0")],
      expected: true,
    },
    {
      description: "[jsonata] nonexistent property -> false",
      state: {},
      matchers: [matchers.jsonata("$exists(agentCoreState.nonexistent)")],
      expected: false,
    },
    {
      description: "[jsonata] invalid expression throws",
      state: {},
      matchers: [matchers.jsonata('`n1028` adf "')],
      throws: true,
    },

    {
      description: "[stripped] matches exact slack channel ID",
      state: { slackChannelId: "C08R1SMTZGD" },
      matchers: [matchers.jsonata("agentCoreState.slackChannelId = 'C08R1SMTZGD'")],
      expected: true,
    },
    {
      description: "[stripped] different slack channel -> false",
      state: { slackChannelId: "C08R1SMTZGD" },
      matchers: [matchers.jsonata("agentCoreState.slackChannelId = 'DIFFERENT_CHANNEL'")],
      expected: false,
    },
    {
      description: "[stripped] participant email contains @nustom.com",
      state: {
        participants: {
          user_456: {
            email: "jonas@nustom.com",
          },
        },
      },
      matchers: [
        matchers.jsonata("$contains(agentCoreState.participants.user_456.email, '@nustom.com')"),
      ],
      expected: true,
    },

    {
      description: "[match] exact string equality",
      state: { systemPrompt: "You are a helpful assistant" },
      matchers: [matchers.jsonata("agentCoreState.systemPrompt = 'You are a helpful assistant'")],
      expected: true,
    },
    {
      description: "[match] boolean equality false",
      state: { paused: false },
      matchers: [matchers.jsonata("agentCoreState.paused = false")],
      expected: true,
    },
    {
      description: "[regex] matches helpful.*assistant",
      state: { systemPrompt: "You are a helpful assistant" },
      matchers: [
        matchers.jsonata("$count($match(agentCoreState.systemPrompt, /helpful.*assistant/)) > 0"),
      ],
      expected: true,
    },
    {
      description: "[contains] includes substring",
      state: { systemPrompt: "You are a helpful assistant" },
      matchers: [matchers.jsonata("$contains(agentCoreState.systemPrompt, 'helpful')")],
      expected: true,
    },
    {
      description: "[contains] missing substring -> false",
      state: { systemPrompt: "You are a helpful assistant" },
      matchers: [matchers.jsonata("$contains(agentCoreState.systemPrompt, 'unhelpful')")],
      expected: false,
    },
    {
      description: "[in] value is in array",
      state: { modelOpts: { model: "gpt-4o-mini" } },
      matchers: [
        matchers.jsonata("agentCoreState.modelOpts.model in ['gpt-4', 'gpt-4o-mini', 'claude-3']"),
      ],
      expected: true,
    },
    {
      description: "[numeric] greater than",
      state: { modelOpts: { temperature: 0.7 } },
      matchers: [matchers.jsonata("agentCoreState.modelOpts.temperature > 0.5")],
      expected: true,
    },
    {
      description: "[numeric] less than or equal",
      state: { modelOpts: { temperature: 0.7 } },
      matchers: [matchers.jsonata("agentCoreState.modelOpts.temperature <= 0.7")],
      expected: true,
    },

    {
      description: "[jsonata] false expression followed by always should return true",
      state: {},
      matchers: [matchers.jsonata("$exists(agentCoreState.nonexistent)"), matchers.always()],
      expected: true,
    },

    {
      description:
        "[jsonata] false expression followed by false expression followed by always should return true",
      state: {},
      matchers: [
        matchers.jsonata("$exists(agentCoreState.nonexistent)"),
        matchers.jsonata("$exists(agentCoreState.alsoNonexistent)"),
        matchers.always(),
      ],
      expected: true,
    },
    // slackChannel matcher
    {
      description: "[slackChannel] matches exact channel ID",
      state: { slackChannelId: "C08R1SMTZGD" },
      matchers: [matchers.slackChannel("C08R1SMTZGD")],
      expected: true,
    },
    {
      description: "[slackChannel] different channel returns false",
      state: { slackChannelId: "C08R1SMTZGD" },
      matchers: [matchers.slackChannel("DIFFERENT_CHANNEL")],
      expected: false,
    },

    // Combinators: and / or / not
    {
      description: "[and] all inner true -> true",
      state: { a: 1, b: 1 },
      matchers: [
        matchers.and(
          matchers.jsonata("agentCoreState.a = 1"),
          matchers.jsonata("agentCoreState.b = 1"),
        ),
      ],
      expected: true,
    },
    {
      description: "[and] one inner false -> false",
      state: { a: 1, b: 2 },
      matchers: [
        matchers.and(
          matchers.jsonata("agentCoreState.a = 1"),
          matchers.jsonata("agentCoreState.b = 1"),
        ),
      ],
      expected: false,
    },
    {
      description: "[or] any inner true -> true",
      state: { x: false, y: true },
      matchers: [
        matchers.or(matchers.jsonata("agentCoreState.x"), matchers.jsonata("agentCoreState.y")),
      ],
      expected: true,
    },
    {
      description: "[or] all inner false -> false",
      state: { x: false, y: false },
      matchers: [
        matchers.or(matchers.jsonata("agentCoreState.x"), matchers.jsonata("agentCoreState.y")),
      ],
      expected: false,
    },
    {
      description: "[not] negates inner result",
      state: { paused: true },
      matchers: [matchers.not(matchers.jsonata("agentCoreState.paused"))],
      expected: false,
    },
    {
      description: "[nested] and(or(x,y), not(z))",
      state: { x: false, y: true, z: false },
      matchers: [
        matchers.and(
          matchers.or(matchers.jsonata("agentCoreState.x"), matchers.jsonata("agentCoreState.y")),
          matchers.not(matchers.jsonata("agentCoreState.z")),
        ),
      ],
      expected: true,
    },
    {
      description: "[vacuous] and([]) is true",
      state: {},
      matchers: [matchers.and()],
      expected: true,
    },
    {
      description: "[vacuous] or([]) is false",
      state: {},
      matchers: [matchers.or()],
      expected: false,
    },
    // hasParticipant matcher (simple string search on stringified participant)
    {
      description: "[hasParticipant] matches string in participant object",
      state: {
        participants: {
          user_1: {
            internalUserId: "user_1",
            email: "jonas@nustom.com",
            displayName: "Jonas Templestein",
          },
        },
      },
      matchers: [matchers.hasParticipant("@nustom.com")],
      expected: true,
    },
    {
      description: "[hasParticipant] matches string in participant array",
      state: {
        participants: [
          { internalUserId: "user_1", email: "a@example.com", displayName: "Jane" },
          { internalUserId: "user_2", email: "b@example.com", displayName: "Sir Jonas the Great" },
        ],
      },
      matchers: [matchers.hasParticipant("Jonas")],
      expected: true,
    },
    {
      description: "[hasParticipant] no match returns false",
      state: {
        participants: [{ internalUserId: "user_1", email: "a@example.com", displayName: "Jane" }],
      },
      matchers: [matchers.hasParticipant("@nustom.com")],
      expected: false,
    },

    // Test case for single quote in hasParticipant search string - should now work
    {
      description: "[hasParticipant] single quote in search string works with JSON.stringify",
      state: {
        participants: {
          user_1: {
            internalUserId: "user_1",
            email: "o'brien@example.com",
            displayName: "O'Brien",
          },
        },
      },
      matchers: [matchers.hasParticipant("O'Brien")],
      expected: true, // Should work now with proper escaping
    },

    // contextContains matcher
    {
      description: "[contextContains] matches in systemPrompt",
      state: {
        systemPrompt: "You are a helpful assistant with special abilities",
        inputItems: [],
        ephemeralPromptFragments: [],
        runtimeTools: [],
      },
      matchers: [matchers.contextContains("helpful")],
      expected: true,
    },
    {
      description: "[contextContains] matches in inputItems",
      state: {
        systemPrompt: "",
        inputItems: [{ content: "Please analyze this data", type: "text" }],
        ephemeralPromptFragments: [],
        runtimeTools: [],
      },
      matchers: [matchers.contextContains("analyze")],
      expected: true,
    },
    {
      description: "[contextContains] matches in ephemeralPromptFragments",
      state: {
        systemPrompt: "",
        inputItems: [],
        ephemeralPromptFragments: [{ content: "Special instructions for today", priority: 1 }],
        runtimeTools: [],
      },
      matchers: [matchers.contextContains("instructions")],
      expected: true,
    },
    {
      description: "[contextContains] no match returns false",
      state: {
        systemPrompt: "Basic prompt",
        inputItems: [],
        ephemeralPromptFragments: [],
        runtimeTools: [],
      },
      matchers: [matchers.contextContains("nonexistent")],
      expected: false,
    },

    // hasTool matcher
    {
      description: "[hasTool] matches tool name in runtimeTools",
      state: {
        runtimeTools: [
          { name: "file_reader", type: "function" },
          { name: "calculator", type: "function" },
        ],
      },
      matchers: [matchers.hasTool("calculator")],
      expected: true,
    },
    {
      description: "[hasTool] matches tool type in runtimeTools",
      state: {
        runtimeTools: [
          { name: "file_reader", type: "function" },
          { name: "web_search", type: "api_call" },
        ],
      },
      matchers: [matchers.hasTool("api_call")],
      expected: true,
    },
    {
      description: "[hasTool] no match returns false",
      state: {
        runtimeTools: [{ name: "file_reader", type: "function" }],
      },
      matchers: [matchers.hasTool("nonexistent")],
      expected: false,
    },

    // Test case for single quote in hasTool search string - should now work
    {
      description: "[hasTool] single quote in search string works with JSON.stringify",
      state: {
        runtimeTools: [{ name: "O'Brien's calculator", type: "function" }],
      },
      matchers: [matchers.hasTool("O'Brien's calculator")],
      expected: true, // Should work now with proper escaping
    },

    // hasMCPConnection matcher
    {
      description: "[hasMCPConnection] matches serverUrl",
      state: {
        mcpConnections: {
          conn1: {
            serverId: "9Db5g6cg",
            serverUrl: "https://api.example.com",
            serverName: "Example API",
          },
          conn2: {
            serverId: "abc123",
            serverUrl: "https://data.example.com",
            serverName: "Data Service",
          },
        },
      },
      matchers: [matchers.hasMCPConnection("api.example.com")],
      expected: true,
    },
    {
      description: "[hasMCPConnection] matches serverName",
      state: {
        mcpConnections: {
          conn1: {
            serverId: "9Db5g6cg",
            serverUrl: "https://api.example.com",
            serverName: "Example API",
          },
          conn2: {
            serverId: "abc123",
            serverUrl: "https://data.example.com",
            serverName: "Data Service",
          },
        },
      },
      matchers: [matchers.hasMCPConnection("Data Service")],
      expected: true,
    },
    {
      description: "[hasMCPConnection] no match returns false",
      state: {
        mcpConnections: {
          conn1: {
            serverId: "9Db5g6cg",
            serverUrl: "https://api.example.com",
            serverName: "Example API",
          },
        },
      },
      matchers: [matchers.hasMCPConnection("nonexistent")],
      expected: false,
    },

    // Test case for single quote in hasMCPConnection search string - should now work
    {
      description: "[hasMCPConnection] single quote in search string works with JSON.stringify",
      state: {
        mcpConnections: {
          conn1: {
            serverId: "9Db5g6cg",
            serverUrl: "https://o'brien-api.com",
            serverName: "O'Brien's API",
          },
        },
      },
      matchers: [matchers.hasMCPConnection("O'Brien's API")],
      expected: true, // Should work now with proper escaping
    },

    // Test case demonstrating the fix - single quote now works with JSON.stringify
    {
      description: "[contextContains] single quote in search string works with JSON.stringify",
      state: {
        systemPrompt: "Contact Adrian O'Brady for help",
        inputItems: [],
        ephemeralPromptFragments: [],
        runtimeTools: [],
      },
      matchers: [matchers.contextContains("Adrian O'Brady")],
      expected: true, // Should work now with proper escaping
    },

    // forAgentClass matcher tests
    {
      description: "[forAgentClass] matches SlackAgent",
      matchAgainst: {
        agentCoreState: {},
        durableObjectClassName: "SlackAgent",
      },
      matchers: [matchers.forAgentClass("SlackAgent")],
      expected: true,
    },
    {
      description: "[forAgentClass] does not match different agent class",
      matchAgainst: {
        agentCoreState: {},
        durableObjectClassName: "TestAgent",
      },
      matchers: [matchers.forAgentClass("SlackAgent")],
      expected: false,
    },
  ];

  it.each(cases)("$description", async (testCase) => {
    // Create a ContextRule object from the test case
    const contextRule: ContextRule = {
      key: "test-rule",
      prompt: "test prompt",
    };

    // Handle different matcher field names for backwards compatibility
    if (testCase.matchers !== undefined) {
      contextRule.match = testCase.matchers;
    }
    const maybeMatch = (testCase as any).match;
    if (maybeMatch !== undefined) {
      contextRule.match = maybeMatch;
    }

    const resultPromise = evaluateContextRuleMatchers({
      contextRule,
      matchAgainst: testCase.matchAgainst || {
        agentCoreState: testCase.state,
        durableObjectClassName: "TestAgent",
      },
    });
    if (testCase.throws) {
      await expect(resultPromise).rejects.toBeDefined();
    } else {
      const result = await resultPromise;
      if (result !== testCase.expected) {
        // Provide detailed error message for debugging
        const matcherDescriptions =
          testCase.matchers
            ?.map((m) => {
              if (m.type === "always") {
                return "always";
              }
              if (m.type === "never") {
                return "never";
              }
              if (m.type === "jsonata") {
                return `jsonata("${m.expression}")`;
              }
              if (m.type === "and") {
                return `and(${m.matchers.length})`;
              }
              if (m.type === "or") {
                return `or(${m.matchers.length})`;
              }
              if (m.type === "not") {
                return "not(...)";
              }
              return "unknown";
            })
            .join(", ") || "none";

        expect.fail(
          `Context rule evaluation failed:\n` +
            `  Expected: ${testCase.expected}\n` +
            `  Got: ${result}\n` +
            `  State: ${JSON.stringify(testCase.state, null, 2)}\n` +
            `  Matchers: [${matcherDescriptions}]\n` +
            `  Description: ${testCase.description}`,
        );
      }
      expect(result).toBe(testCase.expected);
    }
  });
});

describe("timeWindow matcher", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("Only Fridays (UTC)", async () => {
    const rule: ContextRule = {
      key: "fridays",
      prompt: "p",
      match: matchers.timeWindow({ weekdays: ["FR"] }),
    };
    vi.setSystemTime(new Date("2024-07-05T12:00:00Z")); // Friday
    await expect(
      evaluateContextRuleMatchers({
        contextRule: rule,
        matchAgainst: {
          agentCoreState: {},
          durableObjectClassName: "TestAgent",
        },
      }),
    ).resolves.toBe(true);

    vi.setSystemTime(new Date("2024-07-04T12:00:00Z")); // Thursday
    await expect(
      evaluateContextRuleMatchers({
        contextRule: rule,
        matchAgainst: {
          agentCoreState: {},
          durableObjectClassName: "TestAgent",
        },
      }),
    ).resolves.toBe(false);
  });

  it("Night 22:00–06:00 (UTC) cross-midnight", async () => {
    const rule: ContextRule = {
      key: "night",
      prompt: "p",
      match: matchers.timeWindow({ timeOfDay: { start: "22:00", end: "06:00" } }),
    };

    vi.setSystemTime(new Date("2024-07-01T21:59:00Z"));
    await expect(
      evaluateContextRuleMatchers({
        contextRule: rule,
        matchAgainst: { agentCoreState: {}, durableObjectClassName: "TestAgent" },
      }),
    ).resolves.toBe(false);

    vi.setSystemTime(new Date("2024-07-01T22:00:00Z"));
    await expect(
      evaluateContextRuleMatchers({
        contextRule: rule,
        matchAgainst: { agentCoreState: {}, durableObjectClassName: "TestAgent" },
      }),
    ).resolves.toBe(true);

    vi.setSystemTime(new Date("2024-07-02T05:59:00Z"));
    await expect(
      evaluateContextRuleMatchers({
        contextRule: rule,
        matchAgainst: { agentCoreState: {}, durableObjectClassName: "TestAgent" },
      }),
    ).resolves.toBe(true);

    vi.setSystemTime(new Date("2024-07-02T06:00:00Z"));
    await expect(
      evaluateContextRuleMatchers({
        contextRule: rule,
        matchAgainst: { agentCoreState: {}, durableObjectClassName: "TestAgent" },
      }),
    ).resolves.toBe(false);
  });

  it("Exact minute 11/11 11:11 (UTC)", async () => {
    const rule: ContextRule = {
      key: "exact-11-11",
      prompt: "p",
      match: matchers.timeWindow({ exact: { month: 11, day: 11, hour: 11, minute: 11 } }),
    };

    vi.setSystemTime(new Date("2024-11-11T11:11:05Z"));
    await expect(
      evaluateContextRuleMatchers({
        contextRule: rule,
        matchAgainst: { agentCoreState: {}, durableObjectClassName: "TestAgent" },
      }),
    ).resolves.toBe(true);

    vi.setSystemTime(new Date("2024-11-11T11:12:00Z"));
    await expect(
      evaluateContextRuleMatchers({
        contextRule: rule,
        matchAgainst: { agentCoreState: {}, durableObjectClassName: "TestAgent" },
      }),
    ).resolves.toBe(false);
  });
});
