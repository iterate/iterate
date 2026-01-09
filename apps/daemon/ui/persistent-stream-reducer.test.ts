import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Suspense, type ReactNode } from "react";
import {
  usePersistentStream,
  excludeChunks,
  onlyTypes,
  excludeTypes,
} from "./persistent-stream-reducer.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 1;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Auto-emit up-to-date after a tick to resolve Suspense
    setTimeout(() => this.emitControl("up-to-date"), 0);
  }

  close() {
    this.readyState = 2;
  }

  emit(data: unknown, lastEventId?: string) {
    const event = new MessageEvent("message", {
      data: JSON.stringify(data),
      lastEventId,
    });
    this.onmessage?.(event);
  }

  emitControl(control: string) {
    this.emit({ headers: { control } });
  }

  static reset() {
    this.instances = [];
  }
}

Object.defineProperty(globalThis, "EventSource", { value: MockEventSource });

vi.mock("broadcast-channel", () => ({
  BroadcastChannel: class {
    onmessage: ((msg: unknown) => void) | null = null;
    postMessage() {}
    close() {}
  },
  createLeaderElection: () => ({
    awaitLeadership: () => Promise.resolve(),
    die: () => {},
  }),
}));

function SuspenseWrapper({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface TestState {
  items: string[];
  pending: string | null;
}

interface TestEvent {
  type: string;
  id?: string;
  content?: string;
}

const testReducer = (state: TestState, event: TestEvent): TestState => {
  switch (event.type) {
    case "item_start":
      return { ...state, pending: event.id ?? null };
    case "item_chunk":
      return { ...state, pending: (state.pending ?? "") + (event.content ?? "") };
    case "item_complete":
      return { items: [...state.items, event.content ?? ""], pending: null };
    default:
      return state;
  }
};

const initialState: TestState = { items: [], pending: null };

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("usePersistentStream", () => {
  beforeEach(() => {
    localStorageMock.clear();
    MockEventSource.reset();
    vi.clearAllMocks();
  });

  describe("event processing", () => {
    it("processes events through reducer", async () => {
      const { result } = renderHook(
        () =>
          usePersistentStream({
            url: "/test",
            storageKey: "test-1",
            reducer: testReducer,
            initialState,
          }),
        { wrapper: SuspenseWrapper }
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      act(() => {
        MockEventSource.instances[0].emit({ type: "item_complete", content: "hello" });
      });

      await waitFor(() => {
        expect(result.current.state.items).toEqual(["hello"]);
      });
    });

    it("handles null url gracefully", () => {
      const { result } = renderHook(
        () =>
          usePersistentStream({
            url: null,
            storageKey: "test-null",
            reducer: testReducer,
            initialState,
          }),
        { wrapper: SuspenseWrapper }
      );

      expect(result.current.state).toEqual(initialState);
      expect(MockEventSource.instances.length).toBe(0);
    });
  });

  describe("persistence", () => {
    it("persists events to localStorage", async () => {
      renderHook(
        () =>
          usePersistentStream({
            url: "/test",
            storageKey: "test-2",
            reducer: testReducer,
            initialState,
          }),
        { wrapper: SuspenseWrapper }
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      act(() => {
        MockEventSource.instances[0].emit({ type: "item_complete", content: "saved" });
      });

      await waitFor(() => {
        const stored = JSON.parse(localStorage.getItem("test-2:events") ?? "[]");
        expect(stored).toContainEqual({ type: "item_complete", content: "saved" });
      });
    });

    it("respects shouldPersist filter", async () => {
      renderHook(
        () =>
          usePersistentStream({
            url: "/test",
            storageKey: "test-3",
            reducer: testReducer,
            initialState,
            shouldPersist: (e) => e.type !== "item_chunk",
          }),
        { wrapper: SuspenseWrapper }
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      const es = MockEventSource.instances[0];

      act(() => {
        es.emit({ type: "item_start", id: "1" });
        es.emit({ type: "item_chunk", content: "a" });
        es.emit({ type: "item_chunk", content: "b" });
        es.emit({ type: "item_complete", content: "ab" });
      });

      await waitFor(() => {
        const stored = JSON.parse(localStorage.getItem("test-3:events") ?? "[]");
        const types = stored.map((e: TestEvent) => e.type);
        expect(types).toEqual(["item_start", "item_complete"]);
        expect(types).not.toContain("item_chunk");
      });
    });

    it("replays persisted events on mount", async () => {
      localStorage.setItem(
        "test-4:events",
        JSON.stringify([
          { type: "item_complete", content: "first" },
          { type: "item_complete", content: "second" },
        ])
      );

      const { result } = renderHook(
        () =>
          usePersistentStream({
            url: "/test",
            storageKey: "test-4",
            reducer: testReducer,
            initialState,
          }),
        { wrapper: SuspenseWrapper }
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      await waitFor(() => {
        expect(result.current.state.items).toEqual(["first", "second"]);
      });
    });
  });

  describe("offset tracking", () => {
    it("resumes from stored offset", async () => {
      localStorage.setItem("test-5:offset", "saved-offset-123");

      renderHook(
        () =>
          usePersistentStream({
            url: "/test",
            storageKey: "test-5",
            reducer: testReducer,
            initialState,
          }),
        { wrapper: SuspenseWrapper }
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      const url = new URL(MockEventSource.instances[0].url, "http://localhost");
      expect(url.searchParams.get("offset")).toBe("saved-offset-123");
    });

    it("saves offset from SSE lastEventId", async () => {
      renderHook(
        () =>
          usePersistentStream({
            url: "/test",
            storageKey: "test-6",
            reducer: testReducer,
            initialState,
          }),
        { wrapper: SuspenseWrapper }
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      act(() => {
        MockEventSource.instances[0].emit(
          { type: "item_complete", content: "test" },
          "new-offset-456"
        );
      });

      await waitFor(() => {
        expect(localStorage.getItem("test-6:offset")).toBe("new-offset-456");
      });
    });
  });

  describe("streaming state", () => {
    it("tracks streaming from message_start/complete events", async () => {
      const { result } = renderHook(
        () =>
          usePersistentStream({
            url: "/test",
            storageKey: "test-7",
            reducer: testReducer,
            initialState,
          }),
        { wrapper: SuspenseWrapper }
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      expect(result.current.isStreaming).toBe(false);

      act(() => {
        MockEventSource.instances[0].emit({ type: "message_start", id: "1" });
      });

      await waitFor(() => expect(result.current.isStreaming).toBe(true));

      act(() => {
        MockEventSource.instances[0].emit({ type: "message_complete", id: "1" });
      });

      await waitFor(() => expect(result.current.isStreaming).toBe(false));
    });
  });
});

describe("filter helpers", () => {
  it("excludeChunks filters chunk event types", () => {
    expect(excludeChunks({ type: "message_start" })).toBe(true);
    expect(excludeChunks({ type: "message_complete" })).toBe(true);
    expect(excludeChunks({ type: "message_chunk" })).toBe(false);
    expect(excludeChunks({ type: "message_updated" })).toBe(false);
  });

  it("onlyTypes includes specified types", () => {
    const filter = onlyTypes("a", "b");
    expect(filter({ type: "a" })).toBe(true);
    expect(filter({ type: "b" })).toBe(true);
    expect(filter({ type: "c" })).toBe(false);
  });

  it("excludeTypes excludes specified types", () => {
    const filter = excludeTypes("x", "y");
    expect(filter({ type: "x" })).toBe(false);
    expect(filter({ type: "y" })).toBe(false);
    expect(filter({ type: "z" })).toBe(true);
  });
});
