// The preview deploy's wait for its packages (./preview-packages.ts), against a fake pkg.pr.new on a
// fake clock.
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  AWAIT_PUBLISHED,
  awaitPublishedPackages,
  publishedPackagesOf,
} from "./preview-packages.ts";

const commit = "50f20d9e4c5258997c2edfc8f4f8fa640a5045bd";

test("the wait covers what a project installs: every package pkg-pr-new.yml publishes", () => {
  expect(publishedPackagesOf(path.resolve(import.meta.dirname, "../.."))).toEqual(
    expect.arrayContaining([
      "iterate",
      "@iterate-com/agents",
      "@iterate-com/voice",
      "@iterate-com/docs",
    ]),
  );
});

test("the wait asks pkg.pr.new, never esm.sh, for what it does not serve yet, until it serves every package", async () => {
  const pkgPrNew = fakePkgPrNew({
    iterate: (second) => (second < 7 ? 404 : 200),
    "@iterate-com/agents": (second) => (second < 12 ? 404 : 200),
  });

  await awaitPublishedPackages({
    commit,
    packages: ["iterate", "@iterate-com/agents"],
    fetchFn: pkgPrNew.fetch,
    log: pkgPrNew.log,
  });

  expect(pkgPrNew).toMatchObject({
    requests: [
      `0 s HEAD https://pkg.pr.new/iterate/iterate/iterate@${commit}`,
      `0 s HEAD https://pkg.pr.new/iterate/iterate/@iterate-com/agents@${commit}`,
      `5 s HEAD https://pkg.pr.new/iterate/iterate/iterate@${commit}`,
      `5 s HEAD https://pkg.pr.new/iterate/iterate/@iterate-com/agents@${commit}`,
      `10 s HEAD https://pkg.pr.new/iterate/iterate/iterate@${commit}`,
      `10 s HEAD https://pkg.pr.new/iterate/iterate/@iterate-com/agents@${commit}`,
      `15 s HEAD https://pkg.pr.new/iterate/iterate/@iterate-com/agents@${commit}`,
    ],
    logged: [
      `[pkg.pr.new] 0 s: at ${commit}, iterate 404, @iterate-com/agents 404`,
      `[pkg.pr.new] 10 s: at ${commit}, @iterate-com/agents 404`,
      `[pkg.pr.new] 15 s: serves iterate, @iterate-com/agents at ${commit}`,
    ],
  });
});

test("a package pkg.pr.new still does not serve after ten minutes fails the wait, named with the commit", async () => {
  const pkgPrNew = fakePkgPrNew({ iterate: () => 200, "@iterate-com/agents": () => 404 });

  await expect(
    awaitPublishedPackages({
      commit,
      packages: ["iterate", "@iterate-com/agents"],
      fetchFn: pkgPrNew.fetch,
      log: pkgPrNew.log,
    }),
  ).rejects.toThrow(
    `pkg.pr.new did not serve @iterate-com/agents at ${commit} within 10 minutes; pkg-pr-new.yml's run for the commit publishes them (https://github.com/iterate/iterate/actions/workflows/pkg-pr-new.yml). The last answers:\n  https://pkg.pr.new/iterate/iterate/@iterate-com/agents@${commit} 404`,
  );
  expect({ seconds: pkgPrNew.seconds(), logged: pkgPrNew.logged }).toEqual({
    seconds: AWAIT_PUBLISHED.boundMs / 1000,
    logged: [`[pkg.pr.new] 0 s: at ${commit}, @iterate-com/agents 404`],
  });
});

test("pkg.pr.new failing on its own side is asked again a second later, then waited out as not served", async () => {
  const pkgPrNew = fakePkgPrNew({
    iterate: () => 200,
    "@iterate-com/agents": (second) => (second < 7 ? 502 : 200),
  });
  vi.spyOn(Math, "random").mockReturnValue(1);
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

  await awaitPublishedPackages({
    commit,
    packages: ["iterate", "@iterate-com/agents"],
    fetchFn: pkgPrNew.fetch,
    log: pkgPrNew.log,
  });

  expect({
    logged: pkgPrNew.logged,
    warned: warned.mock.calls.map(([line]) => line.event),
  }).toEqual({
    logged: [
      `[pkg.pr.new] 1 s: at ${commit}, @iterate-com/agents 502`,
      `[pkg.pr.new] 7 s: serves iterate, @iterate-com/agents at ${commit}`,
    ],
    warned: [
      "pkg-pr-new.platform-failure-retry",
      "pkg-pr-new.platform-failure-gave-up",
      "pkg-pr-new.platform-failure-retry",
    ],
  });
});

/** pkg.pr.new as HEADs of `iterate/iterate/<package>@<commit>` find it, on a fake clock that moves
 *  on whenever the wait sleeps: each package answers the status its function gives for the second
 *  the request is made at. `requests` and `logged` are what the wait asked and logged. */
function fakePkgPrNew(answers: Record<string, (second: number) => number>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  const started = Date.now();
  const seconds = () => (Date.now() - started) / 1000;
  const requests: string[] = [];
  const logged: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push(`${seconds()} s ${init.method} ${url}`);
    const name = url.match(/^https:\/\/pkg\.pr\.new\/iterate\/iterate\/(.+)@[0-9a-f]{40}$/)![1]!;
    return new Response(null, { status: answers[name]!(seconds()) });
  }) as typeof globalThis.fetch;
  return { fetch, log: (line: string) => void logged.push(line), requests, logged, seconds };
}
