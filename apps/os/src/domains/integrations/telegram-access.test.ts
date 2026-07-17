import { expect, it } from "vitest";
import { TELEGRAM_ACCESS_WELCOME_TEXT, welcomeNewTelegramUsers } from "./telegram-api.ts";

it("welcomes a Telegram user when they are first approved", async () => {
  const messages: Array<{ body: Record<string, unknown>; connection: string }> = [];

  const welcomedUserIds = await welcomeNewTelegramUsers({
    allowedUserIds: ["161412593"],
    connection: "nustombot",
    previouslyAllowedUserIds: [],
    sendTelegramMessage: async (message) => {
      messages.push(message);
    },
  });

  expect(welcomedUserIds).toEqual(["161412593"]);
  expect(messages).toEqual([
    {
      connection: "nustombot",
      body: {
        chat_id: 161412593,
        text: TELEGRAM_ACCESS_WELCOME_TEXT,
      },
    },
  ]);
});

it("does not message users whose access was retained or removed", async () => {
  const messages: unknown[] = [];

  const welcomedUserIds = await welcomeNewTelegramUsers({
    allowedUserIds: ["161412593"],
    connection: "nustombot",
    previouslyAllowedUserIds: ["161412593", "777456"],
    sendTelegramMessage: async (message) => {
      messages.push(message);
    },
  });

  expect(welcomedUserIds).toEqual([]);
  expect(messages).toEqual([]);
});

it("welcomes only the user added to an existing allowlist", async () => {
  const welcomedChatIds: Array<number | string> = [];

  const welcomedUserIds = await welcomeNewTelegramUsers({
    allowedUserIds: ["161412593", "777456"],
    connection: "nustombot",
    previouslyAllowedUserIds: ["161412593"],
    sendTelegramMessage: async ({ body }) => {
      welcomedChatIds.push(body.chat_id as number | string);
    },
  });

  expect(welcomedUserIds).toEqual(["777456"]);
  expect(welcomedChatIds).toEqual([777456]);
});

it("explains that access changed when Telegram rejects the welcome", async () => {
  await expect(
    welcomeNewTelegramUsers({
      allowedUserIds: ["161412593"],
      connection: "nustombot",
      previouslyAllowedUserIds: [],
      sendTelegramMessage: async () => {
        throw new Error("bot was blocked by the user");
      },
    }),
  ).rejects.toThrow(
    "Telegram access was updated, but nustombot could not welcome newly approved user 161412593: bot was blocked by the user",
  );
});

it("identifies only the newly approved users whose welcome failed", async () => {
  const attemptedUserIds: Array<number | string> = [];

  await expect(
    welcomeNewTelegramUsers({
      allowedUserIds: ["161412593", "777456"],
      connection: "nustombot",
      previouslyAllowedUserIds: [],
      sendTelegramMessage: async ({ body }) => {
        attemptedUserIds.push(body.chat_id as number | string);
        if (body.chat_id === 777456) throw new Error("chat not found");
      },
    }),
  ).rejects.toThrow(
    "Telegram access was updated, but nustombot could not welcome newly approved user 777456: chat not found",
  );
  expect(attemptedUserIds).toEqual([161412593, 777456]);
});
