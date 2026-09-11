// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { appendText } from "@iterate-com/shared/chunked-text";
import { StreamingText } from "./streaming-text.tsx";

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test("appending preserves sealed DOM text and the reader's selection", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const first = appendText("", "a".repeat(1024));
  await act(async () => root.render(<StreamingText text={first} />));
  const sealed = host.querySelector("span")!;
  const range = document.createRange();
  range.setStart(sealed.firstChild!, 10);
  range.setEnd(sealed.firstChild!, 20);
  window.getSelection()!.addRange(range);
  await act(async () => root.render(<StreamingText text={appendText(first, " next")} animate />));
  expect(host.querySelector("span")).toBe(sealed);
  expect(window.getSelection()!.toString()).toBe("a".repeat(10));
  expect(host.textContent).toBe("a".repeat(1024) + " next");
});

test("dense streamed whitespace keeps exact text and bounded animation nodes", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  const source = "x ".repeat(400);
  await act(async () => root.render(<StreamingText text={appendText("", source)} animate />));
  expect(host.textContent).toBe(source);
  expect(host.querySelectorAll(".animate-token-in")).toHaveLength(1);
});

test("large live text has a bounded tail and a complete, stable, copyable snapshot", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const source = "old prefix\n" + "x".repeat(100000) + "newest tail";
  const text = appendText("", source);
  await act(async () => root.render(<StreamingText text={text} />));
  expect(host.textContent).not.toContain("old prefix");
  expect(host.textContent).toContain("newest tail");
  expect(host.textContent!.length).toBeLessThan(33000);
  await act(async () => host.querySelector("button")!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("pre")!.textContent).toBe(source);
  await act(async () => root.render(<StreamingText text={appendText(text, " later")} />));
  expect(dialog.querySelector("pre")!.textContent).toBe(source);
  expect(host.textContent).toContain(" later");
  const copy = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Copy text",
  )!;
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  await act(async () => host.querySelector("button")!.click());
  expect(document.querySelector('[role="dialog"] pre')!.textContent).toBe(source + " later");
});
