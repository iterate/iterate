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
  test("resets related palette state atomically when opening and changing tabs", () => {
    const collapsed = reducePaletteDialogState(initialPaletteDialogState(), {
      type: "stream_toggled",
      path: "/agents",
    });
    const opened = reducePaletteDialogState(collapsed, {
      type: "opened",
      tab: "recent",
    });
    const queried = reducePaletteDialogState(opened, {
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

    expect(collapsed.collapsedStreamPaths).toEqual(new Set(["/agents"]));
    expect(opened.collapsedStreamPaths).toEqual(new Set());
    expect(queried.query).toBe("cattle");
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

  test("defaults by route and keeps admin in remote tree mode", () => {
    expect(defaultPaletteTab("/agents", true)).toBe("agents");
    expect(defaultPaletteTab("/agents/research/child", true)).toBe("agents");
    expect(defaultPaletteTab("/repos/config", true)).toBe("recent");
    expect(defaultPaletteTab("/agents", false)).toBe("tree");
  });

  test("accepts only complete canonical stream destinations", () => {
    expect(normalizeDestination("agents/new_task")).toBe("/agents/new_task");
    expect(normalizeDestination("/agents/g~abc-123")).toBeNull();
    expect(normalizeDestination("/agents/")).toBeNull();
    expect(normalizeDestination("/Agents/Bad")).toBeNull();
    expect(normalizeDestination(`/${"a".repeat(1_024)}`)).toBeNull();
  });
});
