// @vitest-environment jsdom
/** @jsxImportSource react */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { ReviewComposer } from "./document-comments.tsx";

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
