import { expect, test } from "vitest";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

// The project fetch lane shows exactly what worker-bundler produced: a good
// repo commit serves with its trusted commit header and Iterate overlay, a
// broken commit fails visibly, and a fixing commit starts serving normally.
test(
  "project host exposes build failures and heals on the next good commit",
  { timeout: 240_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects
      .get(`build-overlay-${crypto.randomUUID().slice(0, 8)}`)
      .create({});
    const { projectId } = await project.__describe();

    const fetchHome = async () => {
      const response = await fetch(buildUrl({ path: `/${projectId}` }));
      const commitOid = response.headers.get("x-iterate-worker-serve");
      return { commitOid, response };
    };
    const deadline = Date.now() + 220_000;
    const pollHome = async (
      accept: (result: Awaited<ReturnType<typeof fetchHome>>) => boolean,
      description: string,
    ) => {
      for (;;) {
        const result = await fetchHome();
        if (accept(result)) return result;
        if (Date.now() > deadline) {
          throw new Error(
            `never saw ${description}; last response: ${result.response.status} ${result.commitOid ?? "no commit"}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    };

    const healthy = await pollHome(
      ({ commitOid, response }) => response.status === 200 && commitOid !== null,
      "a successful worker build",
    );
    const homepage = await healthy.response.text();
    expect(homepage).toContain("Hello from your iterate project worker");
    expect(homepage).toContain("__iterateWorkerOverlay");
    expect(homepage.indexOf("__iterateWorkerOverlay")).toBeGreaterThan(homepage.indexOf("<body"));

    const original = await project.repo.readFile({ path: "worker.ts" });
    expect(original?.content).toContain("export default class ProjectWorker");

    const customIconSource = original!.content.replace(
      "        <html>\n          <body>",
      '        <html>\n          <head><link rel="shortcut ICON" href="/my-icon.svg"></head>\n          <body>',
    );
    expect(customIconSource).not.toBe(original!.content);
    const customized = await project.repo.commitFiles({
      changes: [{ path: "worker.ts", content: customIconSource }],
      message: "set a custom favicon",
    });
    const customIcon = await pollHome(
      ({ commitOid, response }) => response.status === 200 && commitOid === customized.commitOid,
      "the worker with its own favicon",
    );
    const customIconHomepage = await customIcon.response.text();
    expect(customIconHomepage).toContain('rel="shortcut ICON" href="/my-icon.svg"');
    expect(customIconHomepage).not.toContain("data-iterate-default-favicon");

    await project.repo.commitFiles({
      changes: [{ path: "worker.ts", content: "this is not valid typescript ((((" }],
      message: "break the worker build",
    });
    const failed = await pollHome(
      ({ response }) =>
        response.status === 500 && response.headers.get("x-iterate-worker-build-failed") === "1",
      "worker-bundler's build failure",
    );
    expect(failed.commitOid).toBeNull();
    expect(await failed.response.text()).toContain("Worker build failed");

    const fixed = await project.repo.commitFiles({
      changes: [{ path: "worker.ts", content: original!.content }],
      message: "fix the worker build",
    });
    const healed = await pollHome(
      ({ commitOid, response }) => response.status === 200 && commitOid === fixed.commitOid,
      "the fixed worker commit",
    );
    expect(healed).toMatchObject({ commitOid: fixed.commitOid });
    expect(await healed.response.text()).toContain("Hello from your iterate project worker");
  },
);
