import { StreamPath } from "@iterate-com/events-contract";
import { rawEventsStreamViewReducer } from "@iterate-com/ui/components/events/feed-processors";
import { describe, expect, test } from "vitest";
import {
  commandEntries,
  runCommand,
  type AppContext,
  type StreamSummary,
} from "./command-router.ts";
import type { StreamTuiView } from "./navigation-state.ts";

function createTestAppContext() {
  let activeView: StreamTuiView = "feed";
  let inputValue = "";
  let streams: StreamSummary[] = [];
  let toastMessage = "";

  const context: AppContext = {
    get streamPath() {
      return StreamPath.parse("/test");
    },
    get reducedState() {
      return rawEventsStreamViewReducer.createInitialState();
    },
    streamApi: {
      append: async () => {
        throw new Error("append was not expected");
      },
      getState: async () => {
        throw new Error("getState was not expected");
      },
      listChildren: async () => streams,
      reset: async () => {
        throw new Error("reset was not expected");
      },
      resolvePath: (streamPath) => StreamPath.parse(streamPath ?? "/test"),
    },
    setActiveView(view) {
      activeView = view;
    },
    setStreamSummaries(nextStreams) {
      streams = nextStreams;
    },
    navigateToStream() {
      throw new Error("navigateToStream was not expected");
    },
    restartStream() {
      throw new Error("restartStream was not expected");
    },
    prefillInput(value) {
      inputValue = value;
    },
    collapseVisibleFeedItems() {
      toastMessage = "collapsed";
    },
    expandVisibleFeedItems() {
      toastMessage = "expanded";
    },
    toast: {
      info(message) {
        toastMessage = message;
      },
      success(message) {
        toastMessage = message;
      },
      error(message) {
        toastMessage = message;
      },
    },
  };

  return {
    context,
    get activeView() {
      return activeView;
    },
    get inputValue() {
      return inputValue;
    },
    get toastMessage() {
      return toastMessage;
    },
  };
}

describe("commandEntries", () => {
  test("keeps the command hierarchy and slash metadata inspectable", () => {
    expect(commandEntries.map((command) => command.path)).toContain("append.message");
    expect(commandEntries.find((command) => command.path === "append.message")).toMatchObject({
      slash: { name: "append.message", aliases: ["message", "m"] },
      input: { positional: { name: "content", required: true } },
    });
    expect(commandEntries.find((command) => command.path === "stream.reset")).toMatchObject({
      slash: { name: "stream.reset", aliases: ["reset"] },
      input: { flags: [{ name: "destroyChildren", flag: "--no-children", value: false }] },
    });
  });
});

describe("runCommand", () => {
  test("runs view commands through the shared app context", async () => {
    const app = createTestAppContext();
    const command = commandEntries.find((entry) => entry.path === "view.state");

    expect(command).toBeDefined();
    await runCommand({ appContext: app.context, command: command!, inputValue: undefined });

    expect(app.activeView).toBe("state");
  });

  test("runs command helpers without a separate result envelope", async () => {
    const app = createTestAppContext();
    const command = commandEntries.find((entry) => entry.path === "view.commands");

    expect(command).toBeDefined();
    await runCommand({ appContext: app.context, command: command!, inputValue: undefined });

    expect(app.inputValue).toBe("/");
  });
});
