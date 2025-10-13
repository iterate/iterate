import { describe, expect, test } from "vitest";
import type { SlackEvent } from "@slack/types";
import { getMessageMetadata, shouldUnfurlSlackMessage } from "./slack-agent-utils.ts";

describe("shouldUnfurlSlackMessage", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof shouldUnfurlSlackMessage>[0];
    expected: boolean;
  }> = [
    {
      name: "returns true for auto when there is exactly one non-iterate link",
      input: {
        text: "Check this out https://example.com",
        unfurl: "auto",
      },
      expected: true,
    },
    {
      name: "returns false for auto when the message includes an os.iterate.com link",
      input: {
        text: "Authorize here https://os.iterate.com/some-path",
        unfurl: "auto",
      },
      expected: false,
    },
    {
      name: "returns true for all when the message includes an os.iterate.com link",
      input: {
        text: "Authorize here https://os.iterate.com/some-path",
        unfurl: "all",
      },
      expected: true,
    },
    {
      name: "returns false for auto when the message has multiple links",
      input: {
        text: "Multiple links https://example.com and https://example.org",
        unfurl: "auto",
      },
      expected: false,
    },
    {
      name: "returns true for auto when the message includes a linear link",
      input: {
        text: "Issue link https://linear.app/iterate/issue/OPS-123",
        unfurl: "auto",
      },
      expected: true,
    },
  ];

  test.for(cases)("$name", ({ input, expected }) => {
    expect(shouldUnfurlSlackMessage(input)).toBe(expected);
  });
});

describe("thread_ts extraction", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof getMessageMetadata>[0];
    expected: string | undefined;
  }> = [
    {
      name: "regular message: thread starter",
      input: {
        user: "U02F8EFNV",
        type: "message",
        subtype: undefined,
        ts: "1759313891.238619",
        client_msg_id: "50719385-4b66-4c52-add4-77600a60fdae",
        text: "<@U09JHBDJ49X> connect me to <https://backend-03.staging.cloud.chattermill.xyz/public/mcp>",
        team: "T02F8EFNT",
        thread_ts: "1759313848.126189",
        parent_user_id: "U09JHBDJ49X",
        blocks: [
          {
            type: "rich_text",
            block_id: "dvkNe",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "user",
                    user_id: "U09JHBDJ49X",
                  },
                  {
                    type: "text",
                    text: " connect me to ",
                  },
                  {
                    type: "link",
                    url: "https://backend-03.staging.cloud.chattermill.xyz/public/mcp",
                  },
                ],
              },
            ],
          },
        ],
        channel: "D09J8DZGZK6",
        event_ts: "1759313891.238619",
        channel_type: "im",
      },
      expected: "1759313848.126189",
    },
    {
      name: "regular message: thread reply",
      input: {
        user: "U02F8EFNV",
        type: "message",
        subtype: undefined,
        ts: "1759314033.748879",
        client_msg_id: "621b183a-ac33-4899-bf7a-e8eba8f59709",
        text: "<@U09JHBDJ49X> connect me to <https://backend-03.staging.cloud.chattermill.xyz/public/mcp> with require oauth true",
        team: "T02F8EFNT",
        thread_ts: "1759313848.126189",
        parent_user_id: "U09JHBDJ49X",
        blocks: [
          {
            type: "rich_text",
            block_id: "IFYsH",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "user",
                    user_id: "U09JHBDJ49X",
                  },
                  {
                    type: "text",
                    text: " connect me to ",
                  },
                  {
                    type: "link",
                    url: "https://backend-03.staging.cloud.chattermill.xyz/public/mcp",
                  },
                  {
                    type: "text",
                    text: " with require oauth true",
                  },
                ],
              },
            ],
          },
        ],
        channel: "D09J8DZGZK6",
        event_ts: "1759314033.748879",
        channel_type: "im",
      },
      expected: "1759313848.126189",
    },
    {
      name: "new assistant thread event",
      input: {
        type: "message",
        subtype: "message_changed",
        message: {
          text: "New Assistant thread",
          subtype: "assistant_app_thread",
          user: "U09JHBDJ49X",
          type: "message",
          edited: {
            user: "U09JHBDJ49X",
            ts: "1759313891.000000",
          },
          team: "T02F8EFNT",
          thread_ts: "1759313848.126189",
          reply_count: 1,
          reply_users_count: 1,
          latest_reply: "1759313891.238619",
          reply_users: ["U02F8EFNV"],
          is_locked: false,
          blocks: [
            {
              type: "rich_text",
              block_id: "bXD/W",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: "New Assistant thread",
                    },
                  ],
                },
              ],
            },
          ],
          assistant_app_thread: {
            title:
              "<@U09JHBDJ49X> connect me to <https://backend-03.staging.cloud.chattermill.xyz/public/mcp>",
            title_blocks: [
              {
                type: "rich_text",
                block_id: "i73",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [
                      {
                        type: "user",
                        user_id: "U09JHBDJ49X",
                      },
                      {
                        type: "text",
                        text: " connect me to ",
                      },
                      {
                        type: "link",
                        url: "https://backend-03.staging.cloud.chattermill.xyz/public/mcp",
                      },
                    ],
                  },
                ],
              },
            ],
            artifacts: [],
            context: {},
          },
          ts: "1759313848.126189",
        },
        previous_message: {
          text: "New Assistant thread",
          subtype: "assistant_app_thread",
          user: "U09JHBDJ49X",
          type: "message",
          ts: "1759313848.126189",
          team: "T02F8EFNT",
          thread_ts: "1759313848.126189",
          reply_count: 1,
          reply_users_count: 1,
          latest_reply: "1759313891.238619",
          reply_users: ["U02F8EFNV"],
          is_locked: false,
          blocks: [
            {
              type: "rich_text",
              block_id: "hTkgf",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: "New Assistant thread",
                    },
                  ],
                },
              ],
            },
          ],
        },
        channel: "D09J8DZGZK6",
        hidden: true,
        ts: "1759313892.000200",
        event_ts: "1759313892.000200",
        channel_type: "im",
      } as unknown as SlackEvent,
      expected: "1759313848.126189",
    },
    {
      name: "link unfurling / message_changed event",
      input: {
        type: "message",
        subtype: "message_changed",
        message: {
          user: "U09JHBDJ49X",
          type: "message",
          bot_id: "B09J4DZKCNN",
          app_id: "A08NDMDC2JV",
          text: "please authorize Linear here: <https://os.iterate.com/org_01k6fmaxvhfzx83gddh4rr1tp4/est_01k6fmaxw9fzx83gdrp70jq8yk/integrations/redirect?key=QWLn5FIqv8QKcVsQwuuu960J_9Cvy9rz|connect Linear>. i’ll fetch the last 2 days of issues as soon as that’s done.",
          team: "T02F8EFNT",
          bot_profile: {
            id: "B09J4DZKCNN",
            deleted: false,
            name: "iterate",
            updated: 1759313753,
            app_id: "A08NDMDC2JV",
            user_id: "U09JHBDJ49X",
            icons: {
              image_36:
                "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_36.png",
              image_48:
                "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_48.png",
              image_72:
                "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_72.png",
            },
            team_id: "T02F8EFNT",
          },
          thread_ts: "1759313848.126189",
          parent_user_id: "U09JHBDJ49X",
          attachments: [
            {
              from_url:
                "https://os.iterate.com/org_01k6fmaxvhfzx83gddh4rr1tp4/est_01k6fmaxw9fzx83gdrp70jq8yk/integrations/redirect?key=QWLn5FIqv8QKcVsQwuuu960J_9Cvy9rz",
              service_icon: "https://os.iterate.com/favicon.ico",
              id: 1,
              original_url:
                "https://os.iterate.com/org_01k6fmaxvhfzx83gddh4rr1tp4/est_01k6fmaxw9fzx83gdrp70jq8yk/integrations/redirect?key=QWLn5FIqv8QKcVsQwuuu960J_9Cvy9rz",
              fallback: "Login - Iterate",
              text: "Sign in to your Iterate account",
              title: "Login - Iterate",
              title_link:
                "https://os.iterate.com/org_01k6fmaxvhfzx83gddh4rr1tp4/est_01k6fmaxw9fzx83gdrp70jq8yk/integrations/redirect?key=QWLn5FIqv8QKcVsQwuuu960J_9Cvy9rz",
              service_name: "os.iterate.com",
            },
          ],
          blocks: [
            {
              type: "rich_text",
              block_id: "vIC",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: "please authorize Linear here: ",
                    },
                    {
                      type: "link",
                      url: "https://os.iterate.com/org_01k6fmaxvhfzx83gddh4rr1tp4/est_01k6fmaxw9fzx83gdrp70jq8yk/integrations/redirect?key=QWLn5FIqv8QKcVsQwuuu960J_9Cvy9rz",
                      text: "connect Linear",
                    },
                    {
                      type: "text",
                      text: ". i’ll fetch the last 2 days of issues as soon as that’s done.",
                    },
                  ],
                },
              ],
            },
          ],
          ts: "1759314204.266199",
        },
        previous_message: {
          user: "U09JHBDJ49X",
          type: "message",
          ts: "1759314204.266199",
          bot_id: "B09J4DZKCNN",
          app_id: "A08NDMDC2JV",
          text: "please authorize Linear here: <https://os.iterate.com/org_01k6fmaxvhfzx83gddh4rr1tp4/est_01k6fmaxw9fzx83gdrp70jq8yk/integrations/redirect?key=QWLn5FIqv8QKcVsQwuuu960J_9Cvy9rz|connect Linear>. i’ll fetch the last 2 days of issues as soon as that’s done.",
          team: "T02F8EFNT",
          bot_profile: {
            id: "B09J4DZKCNN",
            app_id: "A08NDMDC2JV",
            user_id: "U09JHBDJ49X",
            name: "iterate",
            icons: {
              image_36:
                "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_36.png",
              image_48:
                "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_48.png",
              image_72:
                "https://avatars.slack-edge.com/2025-04-14/8754882306787_221725cd741a3e638c65_72.png",
            },
            deleted: false,
            updated: 1759313753,
            team_id: "T02F8EFNT",
          },
          thread_ts: "1759313848.126189",
          parent_user_id: "U09JHBDJ49X",
          blocks: [
            {
              type: "rich_text",
              block_id: "A0i",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "text",
                      text: "please authorize Linear here: ",
                    },
                    {
                      type: "link",
                      url: "https://os.iterate.com/org_01k6fmaxvhfzx83gddh4rr1tp4/est_01k6fmaxw9fzx83gdrp70jq8yk/integrations/redirect?key=QWLn5FIqv8QKcVsQwuuu960J_9Cvy9rz",
                      text: "connect Linear",
                    },
                    {
                      type: "text",
                      text: ". i’ll fetch the last 2 days of issues as soon as that’s done.",
                    },
                  ],
                },
              ],
            },
          ],
        },
        channel: "D09J8DZGZK6",
        hidden: true,
        ts: "1759314205.004100",
        event_ts: "1759314205.004100",
        channel_type: "im",
      } as unknown as SlackEvent,
      expected: "1759313848.126189",
    },
  ];

  test.for(cases)("$name", async ({ input, expected }) => {
    expect((await getMessageMetadata(input, null as any)).threadTs).toEqual(expected);
  });
});
