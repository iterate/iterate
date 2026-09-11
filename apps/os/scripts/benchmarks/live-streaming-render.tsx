import { appendText, type StreamText } from "@iterate-com/shared/chunked-text";
import { Profiler } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import type { AgentUiActivity } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { AgentLiveActivity } from "@iterate-com/ui/components/agent-feed/agent-live-activity";
import { StreamingCodeBlock } from "@iterate-com/ui/components/agent-feed/streaming-text";

// Stable across every update; this measurement never toggles the activity.
// oxlint-disable-next-line iterate/no-single-use-helpers -- the benchmark deliberately measures a stable callback prop, including React memoization.
const benchmarkToggle = () => {};

let disposePrevious: (() => void) | undefined;

export async function benchmark({
  size = 65536,
  chunkSize = 1024,
  kind = "prose",
  collapsed = false,
  keepMounted = false,
  codePane = false,
} = {}) {
  disposePrevious?.();
  const container = document.createElement("div");
  container.style.cssText =
    "width:min(720px,calc(100vw - 48px));margin:24px;font-family:Arial,sans-serif;white-space:pre-wrap";
  document.body.replaceChildren(container);
  const root = createRoot(container);
  disposePrevious = () => root.unmount();
  const commits: number[] = [],
    updates: number[] = [],
    frames: number[] = [];
  const longTasks: number[] = [];
  let startedAt = Infinity;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime >= startedAt) longTasks.push(entry.duration);
    }
  });
  observer.observe({ type: "longtask" });
  const toggledIds = new Set(collapsed ? [] : ["live-activity:benchmark"]);
  let previousFrame = performance.now();
  let text: StreamText = "";
  const chunk = (
    kind === "code"
      ? "const value = await calculate();\n"
      : "A model response contains words and punctuation.\n"
  )
    .repeat(chunkSize)
    .slice(0, chunkSize);
  for (let offset = 0; offset < size; offset += chunkSize) {
    await new Promise(requestAnimationFrame);
    const frame = performance.now();
    if (offset === 0) startedAt = frame;
    frames.push(frame - previousFrame);
    previousFrame = frame;
    text = appendText(text, chunk);
    const live: AgentUiActivity = {
      id: "benchmark",
      kind: "activity",
      status: "running",
      startedAtMs: Date.now(),
      steps: [
        {
          id: "llm-1",
          kind: "llm",
          status: "running",
          llmRequestOffset: 1,
          startedAtMs: Date.now(),
          responseText: text,
          thinkingText: "",
        },
      ],
    };
    const at = performance.now();
    flushSync(() =>
      root.render(
        <Profiler id="live" onRender={(_id, _phase, duration) => commits.push(duration)}>
          {codePane ? (
            <StreamingCodeBlock code={text} />
          ) : (
            <AgentLiveActivity
              live={live}
              runtime={ZERO_AGENT_RUNTIME}
              toggledIds={toggledIds}
              onToggle={benchmarkToggle}
            />
          )}
        </Profiler>,
      ),
    );
    container.getBoundingClientRect();
    updates.push(performance.now() - at);
  }
  await new Promise(requestAnimationFrame);
  const summary = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return {
      count: values.length,
      total: values.reduce((a, b) => a + b, 0),
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted.at(-1),
    };
  };
  const result = {
    size,
    chunkSize,
    kind,
    collapsed,
    codePane,
    commits: summary(commits),
    updateAndLayout: summary(updates),
    frames: summary(frames),
    longTasks: summary(longTasks),
    codePanes: container.querySelectorAll("pre").length,
    animatedSpans: container.querySelectorAll(".animate-token-in").length,
    elements: container.querySelectorAll("*").length,
    displayedChars: container.textContent?.length,
  };
  observer.disconnect();
  if (!keepMounted) root.unmount();
  return result;
}
