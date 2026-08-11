import { expect } from "@playwright/test";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// The browser-adoption proof for projects.connect: every OS dashboard tab on a
// project connects as a client at /clients/os-app/<tab-key> (sessionStorage
// keys the path, so two tabs are two clients) carrying a live browser
// capability. An itx caller lists both in the clients catalog and drives each
// tab's SPA router INDEPENDENTLY through capabilities.browser.navigate.

test("two dashboard tabs are two clients; an itx caller navigates each independently", async ({
  baseURL,
  context,
  helpers,
  page,
}) => {
  test.setTimeout(240_000);
  await using fixture = await helpers.createFixture("clients-os-app");
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
  const slug = fixture.project.slug;

  using admin = await connectAdminItx(baseURL);
  using project = admin.projects.get(fixture.project.id);

  const connectedOsAppClients = async () => {
    const list = await project.clients.list();
    return list
      .filter((client) => client.path.startsWith("/clients/os-app/") && client.connected)
      .map((client) => client.path)
      .sort();
  };

  await test.step("tab one connects as a client", async () => {
    await page.goto(`/projects/${slug}/repl`);
    await expect.poll(connectedOsAppClients, { timeout: 60_000, intervals: [500] }).toHaveLength(1);
  });

  const pageTwo = await context.newPage();
  await test.step("tab two is a SECOND client", async () => {
    await pageTwo.goto(`/projects/${slug}/integrations`);
    await expect.poll(connectedOsAppClients, { timeout: 60_000, intervals: [500] }).toHaveLength(2);
  });
  const bothPaths = await connectedOsAppClients();

  // Map catalog paths to tabs via each client's own url() capability — the
  // call executes INSIDE the owning tab, so it self-identifies (the two tabs
  // were tagged with distinct SPA locations above). `connected` is the
  // provider Pager's durable presence fact; the capability mount is the next
  // durable fact. Under a fully parallel preview the catalog can therefore
  // lead the callable surface briefly, so synchronize on the public call.
  const tabUrl = async (clientPath: string): Promise<string> => {
    let url: string | undefined;
    await expect
      .poll(
        async () => {
          using host = project.clients.get(clientPath);
          try {
            // @ts-expect-error - dynamic capability member
            url = (await host.capabilities.browser.url()) as string;
            return "ready";
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'no capability "capabilities.browser.url"'
            ) {
              return "mounting";
            }
            throw error;
          }
        },
        { timeout: 15_000 },
      )
      .toBe("ready");
    if (url === undefined) throw new Error(`client ${clientPath} reported ready without a URL`);
    return url;
  };
  const urls = await Promise.all(bothPaths.map((clientPath) => tabUrl(clientPath)));
  // Bare /repl resolves to a session URL (/repl/<timestamp-slug>) on arrival,
  // so tab one matches on the prefix, not an exact suffix.
  const replUrl = new RegExp(`/projects/${slug}/repl(/|$)`);
  const ofPage = bothPaths[urls.findIndex((url) => replUrl.test(url))];
  const ofPageTwo =
    bothPaths[urls.findIndex((url) => url.endsWith(`/projects/${slug}/integrations`))];
  if (ofPage === undefined || ofPageTwo === undefined || ofPage === ofPageTwo) {
    throw new Error(`could not map clients to tabs: paths=${bothPaths} urls=${urls}`);
  }

  await test.step("navigate ONLY tab two; tab one must not move", async () => {
    using host = project.clients.get(ofPageTwo);
    // @ts-expect-error - dynamic capability member
    await host.capabilities.browser.navigate(`/projects/${slug}/repl`);
    await expect.poll(() => pageTwo.url(), { timeout: 15_000 }).toMatch(replUrl);
    // Tab one stays on its own tag, unchanged.
    await expect.poll(() => page.url()).toMatch(replUrl);
  });

  await test.step("navigate ONLY tab one to a third route; tab two stays put", async () => {
    using host = project.clients.get(ofPage);
    // @ts-expect-error - dynamic capability member
    await host.capabilities.browser.navigate(`/projects/${slug}/settings`);
    await expect
      .poll(() => page.url(), { timeout: 15_000 })
      .toMatch(new RegExp(`/projects/${slug}/settings`));
    await expect.poll(() => pageTwo.url()).toMatch(replUrl);
  });

  await test.step("a DUPLICATED tab (copied sessionStorage) mints its own client", async () => {
    // Tab duplication copies sessionStorage — seed a third tab with tab two's
    // stored key. The BroadcastChannel claim must detect the live holder and
    // mint a fresh key: three clients, never a collapsed two.
    const copiedKey = await pageTwo.evaluate(() =>
      window.sessionStorage.getItem("iterate-os-app-tab-key"),
    );
    const pageThree = await context.newPage();
    await pageThree.addInitScript((key) => {
      window.sessionStorage.setItem("iterate-os-app-tab-key", key);
    }, copiedKey);
    await pageThree.goto(`/projects/${slug}/reactivity`);
    await expect.poll(connectedOsAppClients, { timeout: 60_000, intervals: [500] }).toHaveLength(3);
    await pageThree.close();
  });

  await test.step("closing tab two flips exactly its client to disconnected", async () => {
    await pageTwo.close();
    await expect
      .poll(connectedOsAppClients, { timeout: 60_000, intervals: [1_000] })
      .toEqual([ofPage]);
  });
});
