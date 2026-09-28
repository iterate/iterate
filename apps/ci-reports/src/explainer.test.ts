import { expect, test } from "vitest";
import { serveExplainer } from "./explainer.ts";

test("an explainer on a pull request's branch opens from GitHub, as committed", async () => {
  const asked: string[] = [];
  const response = await serveExplainer(
    new Request(
      "https://ci-reports.iterate-dev-preview.workers.dev/explainers/ci-change-detection/ci-inherit-and-reuse",
    ),
    {
      fetch: async (url) => {
        asked.push(String(url));
        return new Response("<!doctype html><title>CI Inherit and Reuse</title>");
      },
    },
  );
  expect(asked).toEqual([
    "https://raw.githubusercontent.com/iterate/iterate/ci-change-detection/explainers/ci-inherit-and-reuse.html",
  ]);
  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toBe("<!doctype html><title>CI Inherit and Reuse</title>");
});

test("a branch with slashes, or a commit, is the ref; `.html` on the name is optional", async () => {
  const asked: string[] = [];
  const fetch = async (url: RequestInfo | URL) => {
    asked.push(String(url));
    return new Response("page");
  };
  for (const path of ["codex/lazy-preview/timeline.html", "0e4f7a2/timeline/"])
    await serveExplainer(
      new Request(`https://ci-reports.iterate-dev-preview.workers.dev/explainers/${path}`),
      { fetch },
    );
  expect(asked).toEqual([
    "https://raw.githubusercontent.com/iterate/iterate/codex/lazy-preview/explainers/timeline.html",
    "https://raw.githubusercontent.com/iterate/iterate/0e4f7a2/explainers/timeline.html",
  ]);
});

test("a page the ref doesn't have is a 404 that names it and, off main, links main's copy; a ref with an encoded character is refused unasked", async () => {
  const missing = await serveExplainer(
    new Request("https://ci-reports.iterate-dev-preview.workers.dev/explainers/main/nope"),
    { fetch: async () => new Response("404: Not Found", { status: 404 }) },
  );
  expect(missing).toMatchObject({ status: 404 });
  expect(await missing.text()).toBe("No explainers/nope.html at main");

  // most likely a merged pull request's deleted branch: main's copy is a click away
  const merged = await serveExplainer(
    new Request(
      "https://ci-reports.iterate-dev-preview.workers.dev/explainers/ci-change-detection/ci-inherit-and-reuse",
    ),
    { fetch: async () => new Response("404: Not Found", { status: 404 }) },
  );
  expect(merged).toMatchObject({ status: 404 });
  expect(merged.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await merged.text()).toContain('<a href="/explainers/main/ci-inherit-and-reuse">');

  const traversal = await serveExplainer(
    new Request(
      "https://ci-reports.iterate-dev-preview.workers.dev/explainers/main%2F..%2F..%2Fsecrets/x",
    ),
    {
      fetch: async () => {
        throw new Error("GitHub was asked");
      },
    },
  );
  expect(traversal).toMatchObject({ status: 400 });
});
