import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import YAML from "yaml";
import {
  reduceEvents,
  createInitialState,
  messagesReducer,
  getMessages,
} from "./messages-reducer.ts";

/**
 * Parse a YAML stream file and extract events from the messages array.
 * Each message in the YAML has a `content` field which is the actual event.
 */
function parseYamlStream(yamlString: string): unknown[] {
  const data = YAML.parse(yamlString);
  if (!data?.messages || !Array.isArray(data.messages)) {
    return [];
  }
  // Extract the `content` field from each message, which is the actual event
  return data.messages.map((m: any) => m.content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test data: Minimal conversation with one user message and assistant response
// ─────────────────────────────────────────────────────────────────────────────

const SINGLE_TURN_YAML = `
id: test
contentType: application/json
createdAt: 2026-01-05T20:00:00.000Z
messages:
  - offset: "1"
    content:
      type: user_prompt
      text: hello
    timestamp: 2026-01-05T20:00:01.000Z
    source: user
    metadata: {}
  - offset: "2"
    content:
      type: agent_start
    timestamp: 2026-01-05T20:00:01.001Z
    source: system
    metadata: {}
  - offset: "3"
    content:
      type: message_start
      message:
        role: user
        content:
          - type: text
            text: hello
        timestamp: 1234567890
    timestamp: 2026-01-05T20:00:01.002Z
    source: user
    metadata: {}
  - offset: "4"
    content:
      type: message_end
      message:
        role: user
        content:
          - type: text
            text: hello
        timestamp: 1234567890
    timestamp: 2026-01-05T20:00:01.003Z
    source: user
    metadata: {}
  - offset: "5"
    content:
      type: message_start
      message:
        role: assistant
        content: []
        timestamp: 1234567891
    timestamp: 2026-01-05T20:00:01.004Z
    source: assistant
    metadata: {}
  - offset: "6"
    content:
      type: message_update
      assistantMessageEvent:
        type: text_delta
        partial:
          role: assistant
          content:
            - type: text
              text: "Hi there!"
          timestamp: 1234567891
    timestamp: 2026-01-05T20:00:01.005Z
    source: assistant
    metadata: {}
  - offset: "7"
    content:
      type: message_end
      message:
        role: assistant
        content:
          - type: text
            text: "Hi there!"
        timestamp: 1234567891
    timestamp: 2026-01-05T20:00:01.006Z
    source: assistant
    metadata: {}
  - offset: "8"
    content:
      type: agent_end
      messages:
        - role: user
          content:
            - type: text
              text: hello
        - role: assistant
          content:
            - type: text
              text: "Hi there!"
    timestamp: 2026-01-05T20:00:01.007Z
    source: system
    metadata: {}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Test data: Two-turn conversation
// ─────────────────────────────────────────────────────────────────────────────

const TWO_TURN_YAML = `
id: test
contentType: application/json
createdAt: 2026-01-05T20:00:00.000Z
messages:
  # First turn
  - offset: "1"
    content:
      type: user_prompt
      text: haha
    timestamp: 2026-01-05T20:00:01.000Z
    source: user
    metadata: {}
  - offset: "2"
    content:
      type: message_start
      message:
        role: user
        content:
          - type: text
            text: haha
        timestamp: 1000
    timestamp: 2026-01-05T20:00:01.001Z
    source: user
    metadata: {}
  - offset: "3"
    content:
      type: message_start
      message:
        role: assistant
        content: []
        timestamp: 1001
    timestamp: 2026-01-05T20:00:01.002Z
    source: assistant
    metadata: {}
  - offset: "4"
    content:
      type: message_update
      assistantMessageEvent:
        type: text_delta
        partial:
          role: assistant
          content:
            - type: text
              text: "Haha! 😄"
          timestamp: 1001
    timestamp: 2026-01-05T20:00:01.003Z
    source: assistant
    metadata: {}
  - offset: "5"
    content:
      type: message_end
      message:
        role: assistant
        content:
          - type: text
            text: "Haha! 😄"
        timestamp: 1001
    timestamp: 2026-01-05T20:00:01.004Z
    source: assistant
    metadata: {}
  - offset: "6"
    content:
      type: agent_end
      messages:
        - role: user
          content:
            - type: text
              text: haha
        - role: assistant
          content:
            - type: text
              text: "Haha! 😄"
    timestamp: 2026-01-05T20:00:01.005Z
    source: system
    metadata: {}
  # Second turn
  - offset: "7"
    content:
      type: user_prompt
      text: why not laugh more?
    timestamp: 2026-01-05T20:00:02.000Z
    source: user
    metadata: {}
  - offset: "8"
    content:
      type: message_start
      message:
        role: user
        content:
          - type: text
            text: why not laugh more?
        timestamp: 2000
    timestamp: 2026-01-05T20:00:02.001Z
    source: user
    metadata: {}
  - offset: "9"
    content:
      type: message_start
      message:
        role: assistant
        content: []
        timestamp: 2001
    timestamp: 2026-01-05T20:00:02.002Z
    source: assistant
    metadata: {}
  - offset: "10"
    content:
      type: message_update
      assistantMessageEvent:
        type: text_delta
        partial:
          role: assistant
          content:
            - type: text
              text: "You got me there! 😂"
          timestamp: 2001
    timestamp: 2026-01-05T20:00:02.003Z
    source: assistant
    metadata: {}
  - offset: "11"
    content:
      type: message_end
      message:
        role: assistant
        content:
          - type: text
            text: "You got me there! 😂"
        timestamp: 2001
    timestamp: 2026-01-05T20:00:02.004Z
    source: assistant
    metadata: {}
  - offset: "12"
    content:
      type: agent_end
      messages:
        - role: user
          content:
            - type: text
              text: why not laugh more?
        - role: assistant
          content:
            - type: text
              text: "You got me there! 😂"
    timestamp: 2026-01-05T20:00:02.005Z
    source: system
    metadata: {}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("messagesReducer", () => {
  describe("single turn conversation", () => {
    it("should reduce a complete conversation to messages", () => {
      const events = parseYamlStream(SINGLE_TURN_YAML);
      const state = reduceEvents(events);

      expect(getMessages(state)).toHaveLength(2);
      expect(state.isStreaming).toBe(false);
      expect(state.streamingMessage).toBeUndefined();
    });

    it("should have correct user message", () => {
      const events = parseYamlStream(SINGLE_TURN_YAML);
      const state = reduceEvents(events);
      const messages = getMessages(state);

      expect(messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "hello" }],
      });
    });

    it("should have correct assistant message", () => {
      const events = parseYamlStream(SINGLE_TURN_YAML);
      const state = reduceEvents(events);
      const messages = getMessages(state);

      expect(messages[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
        timestamp: 1234567891,
      });
    });

    it("should track all raw events", () => {
      const events = parseYamlStream(SINGLE_TURN_YAML);
      const state = reduceEvents(events);

      expect(state.rawEvents).toHaveLength(events.length);
    });
  });

  describe("two turn conversation", () => {
    it("should preserve messages across turns (agent_end should not replace)", () => {
      const events = parseYamlStream(TWO_TURN_YAML);
      const state = reduceEvents(events);

      // Should have 4 messages: 2 user + 2 assistant
      expect(getMessages(state)).toHaveLength(4);
      expect(state.isStreaming).toBe(false);
    });

    it("should have all messages in correct order", () => {
      const events = parseYamlStream(TWO_TURN_YAML);
      const state = reduceEvents(events);
      const messages = getMessages(state);

      expect(messages[0].role).toBe("user");
      expect(messages[0].content[0].text).toBe("haha");

      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content[0].text).toBe("Haha! 😄");

      expect(messages[2].role).toBe("user");
      expect(messages[2].content[0].text).toBe("why not laugh more?");

      expect(messages[3].role).toBe("assistant");
      expect(messages[3].content[0].text).toBe("You got me there! 😂");
    });
  });

  describe("streaming state", () => {
    it("should set isStreaming=true on assistant message_start", () => {
      let state = createInitialState();
      state = messagesReducer(state, {
        type: "message_start",
        message: { role: "assistant", content: [], timestamp: 123 },
      });

      expect(state.isStreaming).toBe(true);
      expect(state.streamingMessage).toMatchObject({
        role: "assistant",
        content: [],
        timestamp: 123,
      });
    });

    it("should update streamingMessage on message_update", () => {
      let state = createInitialState();
      state = messagesReducer(state, {
        type: "message_start",
        message: { role: "assistant", content: [], timestamp: 123 },
      });
      state = messagesReducer(state, {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          partial: {
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            timestamp: 123,
          },
        },
      });

      expect(state.isStreaming).toBe(true);
      expect(state.streamingMessage?.content[0].text).toBe("Hello");
    });

    it("should finalize message and stop streaming on message_end", () => {
      let state = createInitialState();
      state = messagesReducer(state, {
        type: "message_start",
        message: { role: "assistant", content: [], timestamp: 123 },
      });
      state = messagesReducer(state, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final message" }],
          timestamp: 123,
        },
      });

      expect(state.isStreaming).toBe(false);
      expect(state.streamingMessage).toBeUndefined();
      const messages = getMessages(state);
      expect(messages).toHaveLength(1);
      expect(messages[0].content[0].text).toBe("Final message");
    });
  });

  describe("duplicate detection", () => {
    it("should not add duplicate user messages from user_prompt", () => {
      let state = createInitialState();
      state = messagesReducer(state, { type: "user_prompt", text: "hello" });
      state = messagesReducer(state, { type: "user_prompt", text: "hello" });

      expect(getMessages(state)).toHaveLength(1);
    });

    it("should not add duplicate user messages from message_start", () => {
      let state = createInitialState();
      state = messagesReducer(state, { type: "user_prompt", text: "hello" });
      state = messagesReducer(state, {
        type: "message_start",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 123,
        },
      });

      expect(getMessages(state)).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("should handle empty events array", () => {
      const state = reduceEvents([]);

      expect(getMessages(state)).toHaveLength(0);
      expect(state.isStreaming).toBe(false);
      expect(state.rawEvents).toHaveLength(0);
    });

    it("should pass through unknown event types", () => {
      let state = createInitialState();
      state = messagesReducer(state, { type: "unknown_event", data: "test" });

      expect(getMessages(state)).toHaveLength(0);
      expect(state.rawEvents).toHaveLength(1);
    });

    it("should handle turn_start and agent_start events gracefully", () => {
      let state = createInitialState();
      state = messagesReducer(state, { type: "turn_start" });
      state = messagesReducer(state, { type: "agent_start" });

      expect(getMessages(state)).toHaveLength(0);
      expect(state.rawEvents).toHaveLength(2);
    });
  });

  describe("real YAML data from hi.yaml", () => {
    // Load the actual hi.yaml file from the .iterate directory
    const loadHiYaml = () => {
      const yamlPath = join(__dirname, "../../.iterate/hi.yaml");
      try {
        return readFileSync(yamlPath, "utf-8");
      } catch {
        return null;
      }
    };

    it("should correctly reduce the real hi.yaml conversation", () => {
      const yamlContent = loadHiYaml();
      if (!yamlContent) {
        console.log("Skipping: hi.yaml not found");
        return;
      }

      const events = parseYamlStream(yamlContent);
      const state = reduceEvents(events);

      // Based on the hi.yaml content, we expect:
      // - User: "haha"
      // - Assistant: "Haha! 😄 What can I help you with today?..."
      // - User: "why are you not laughing?"
      // - Assistant: "You got me there! 😂..."
      const messages = getMessages(state);
      expect(messages.length).toBeGreaterThanOrEqual(4);
      expect(state.isStreaming).toBe(false);

      // First user message
      expect(messages[0].role).toBe("user");
      expect(messages[0].content[0].text).toBe("haha");

      // First assistant response
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content[0].text).toContain("Haha!");

      // Second user message
      expect(messages[2].role).toBe("user");
      expect(messages[2].content[0].text).toBe("why are you not laughing?");

      // Second assistant response
      expect(messages[3].role).toBe("assistant");
      expect(messages[3].content[0].text).toContain("You got me there!");
    });

    it("should handle all event types from real data without crashing", () => {
      const yamlContent = loadHiYaml();
      if (!yamlContent) {
        console.log("Skipping: hi.yaml not found");
        return;
      }

      const events = parseYamlStream(yamlContent);

      // This should not throw
      expect(() => reduceEvents(events)).not.toThrow();
    });

    it("should track all raw events from real data", () => {
      const yamlContent = loadHiYaml();
      if (!yamlContent) {
        console.log("Skipping: hi.yaml not found");
        return;
      }

      const events = parseYamlStream(yamlContent);
      const state = reduceEvents(events);

      // All events should be tracked
      expect(state.rawEvents).toHaveLength(events.length);
    });
  });
});
