import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { AgentPillComposer } from "./agent-pill-composer.tsx";

test.each([false, true])(
  "pending sends remain visibly marked while interrupt is %s",
  (interrupt) => {
    const html = renderToStaticMarkup(
      <AgentPillComposer
        mode="message"
        onModeChange={() => {}}
        message={{ value: { content: "Hello" }, onValueChange() {}, onSubmit() {} }}
        isSubmitting
        onInterrupt={interrupt ? () => {} : undefined}
      />,
    );
    expect(html).toContain('data-spinner="true"');
    expect(html).toContain("Sending…");
  },
);
