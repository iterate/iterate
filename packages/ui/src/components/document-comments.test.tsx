// @vitest-environment jsdom
/** @jsxImportSource react */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { DocumentComments, ReviewComposer } from "./document-comments.tsx";

test("document and reply drafts survive temporary read-only state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const threads = [
    {
      id: "c1",
      status: "open" as const,
      comments: [{ id: "c1", author: "A", createdAt: null, body: "Review this." }],
    },
  ];
  const onAction = vi.fn(() => true);
  const render = (writable: boolean) =>
    root.render(
      <DocumentComments
        threads={threads}
        renderComment={(body) => body}
        onAction={writable ? onAction : undefined}
      />,
    );
  try {
    await act(async () => render(true));
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Reply")!
        .click(),
    );
    const drafts = [...host.querySelectorAll("textarea")];
    await act(async () => {
      drafts.forEach((textarea, index) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          textarea,
          `Draft ${index}`,
        );
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
    await act(async () => render(false));
    expect([...host.querySelectorAll("textarea")].map((textarea) => textarea.value)).toEqual([
      "Draft 0",
      "Draft 1",
    ]);
    const submit = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Add document comment",
    )!;
    expect(submit.disabled).toBe(true);
    await act(async () => render(true));
    expect([...host.querySelectorAll("textarea")].map((textarea) => textarea.value)).toEqual([
      "Draft 0",
      "Draft 1",
    ]);
    await act(async () => submit.click());
    expect(onAction).toHaveBeenCalledWith({ kind: "add-document-comment", body: "Draft 1" });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

test("submission applies locally, retains a rejected draft, and never clears later typing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let available = false;
  const onSubmit = vi.fn(() => available);
  try {
    await act(async () => {
      root.render(
        <ReviewComposer
          initialValue="First comment"
          placeholder="Comment"
          submitLabel="Send"
          onSubmit={onSubmit}
        />,
      );
    });
    const textarea = host.querySelector("textarea")!;
    await act(async () => host.querySelector("button")!.click());
    expect(textarea.value).toBe("First comment");
    available = true;
    await act(async () => host.querySelector("button")!.click());
    expect(onSubmit).toHaveBeenLastCalledWith("First comment");
    expect(textarea.value).toBe("");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "Next comment",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea.value).toBe("Next comment");
    expect(textarea.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
