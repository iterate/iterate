import { describe, expect, test } from "vitest";
import {
  agentCommandValue,
  defaultPaletteTab,
  hasPathDescendant,
  initialPaletteDialogState,
  normalizeDestination,
  paletteKeyboardAction,
  paletteKeyboardTarget,
  reducePaletteDialogState,
} from "./command-palette-model.ts";

describe("command palette models", () => {
  test("initializes related palette state atomically and preserves it across tab changes", () => {
    const initial = initialPaletteDialogState("recent");
    const collapsed = reducePaletteDialogState(initial, {
      type: "stream_toggled",
      path: "/agents",
    });
    const queried = reducePaletteDialogState(collapsed, {
      type: "query_changed",
      query: "cattle",
    });
    const selected = reducePaletteDialogState(queried, {
      type: "selection_changed",
      selectedValue: "/agents/research",
    });
    const changedTab = reducePaletteDialogState(selected, {
      type: "tab_changed",
      tab: "agents",
    });

    expect(initial).toMatchObject({ tab: "recent", query: "", selectedValue: "" });
    expect(collapsed.collapsedStreamPaths).toEqual(new Set(["/agents"]));
    expect(queried.query).toBe("cattle");
    expect(changedTab.collapsedStreamPaths).toEqual(new Set(["/agents"]));
    expect(changedTab).toMatchObject({
      tab: "agents",
      query: "cattle",
      selectedValue: "",
    });
  });

  test("prefixes agent cmdk identities so they cannot collide with stream paths", () => {
    expect(agentCommandValue("/agents/research")).toBe("agent:/agents/research");
  });

  test("routes root-level cmdk keys to the selected row", () => {
    const target = paletteKeyboardTarget("agents", "agent:/agents/research");
    if (target === undefined) throw new Error("missing keyboard target");

    expect(
      paletteKeyboardAction({
        target,
        key: "ArrowRight",
        shiftKey: false,
        query: "",
        hasChildren: true,
        expanded: false,
      }),
    ).toBe("expand");
    expect(
      paletteKeyboardAction({
        target,
        key: "P",
        shiftKey: true,
        query: "",
        hasChildren: true,
        expanded: false,
      }),
    ).toBe("toggle_pin");
    expect(
      paletteKeyboardAction({
        target,
        key: "ArrowRight",
        shiftKey: false,
        query: "research",
        hasChildren: true,
        expanded: false,
      }),
    ).toBeUndefined();
  });

  test("finds descendants for agent paths and the stream root", () => {
    expect(
      hasPathDescendant(["/agents/research", "/agents/research/child"], "/agents/research"),
    ).toBe(true);
    expect(hasPathDescendant(["/", "/agents"], "/")).toBe(true);
    expect(hasPathDescendant(["/agents/research"], "/agents/research")).toBe(false);
  });

  test("defaults project navigation by route", () => {
    expect(defaultPaletteTab("/agents")).toBe("agents");
    expect(defaultPaletteTab("/agents/research/child")).toBe("agents");
    expect(defaultPaletteTab("/repos/config")).toBe("recent");
  });

  test("accepts only complete canonical stream destinations", () => {
    expect(normalizeDestination("agents/new_task")).toBe("/agents/new_task");
    expect(normalizeDestination("/agents/g~abc-123")).toBeNull();
    expect(normalizeDestination("/agents/")).toBeNull();
    expect(normalizeDestination("/Agents/Bad")).toBeNull();
    expect(normalizeDestination(`/${"a".repeat(1_024)}`)).toBeNull();
  });
});
