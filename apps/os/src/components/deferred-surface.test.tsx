// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { DeferredSurface } from "./deferred-surface.tsx";

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

test("does not build or subscribe while closed and releases work when closed again", async () => {
  let modelBuilds = 0;
  let subscriptions = 0;
  let releases = 0;
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);

  function WorkProbe() {
    modelBuilds += 1;
    useEffect(() => {
      subscriptions += 1;
      return () => {
        releases += 1;
      };
    }, []);
    return null;
  }

  async function render(active: boolean) {
    await act(async () => {
      root.render(
        <DeferredSurface active={active}>
          <WorkProbe />
        </DeferredSurface>,
      );
    });
  }

  await render(false);
  expect(modelBuilds).toBe(0);
  expect(subscriptions).toBe(0);
  expect(releases).toBe(0);

  await render(true);
  expect(modelBuilds).toBe(1);
  expect(subscriptions).toBe(1);
  expect(releases).toBe(0);

  await render(false);
  expect(modelBuilds).toBe(1);
  expect(subscriptions).toBe(1);
  expect(releases).toBe(1);
});
