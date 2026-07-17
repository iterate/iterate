import { expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { WebClient } from "@slack/web-api";
import { PathFunctionTarget, startMockSlack } from "./itx-test-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// These are hand written tests - they MUST pass
test("Nested plain-object live capability members survive after provideCapability returns", async () => {
  const marker = crypto.randomUUID();

  using providerSession = withItxSession();
  using providerItx = providerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = providerItx.projects.create({ slug: `nested-live-${marker}` });
  const { projectId } = await project.__describe();

  using _toolsProvision = await project.provideCapability({
    path: ["tools"],
    type: "live",
    capability: {
      math: {
        add(a: number, b: number) {
          return { marker, sum: a + b };
        },
      },
    },
  });

  using callerSession = withItxSession();
  using callerItx = callerSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      principal: "alice",
      projectScopes: [projectId],
      type: "user",
    },
  });
  using callerProject = callerItx.projects.get(projectId);

  // @ts-expect-error - dynamic capability root
  expect(await callerProject.tools.math.add(20, 22)).toEqual({ marker, sum: 42 });
});

test("Live capabilities reject the removed target spelling", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `removed-target-${crypto.randomUUID()}` });

  await expect(
    project.provideCapability({
      path: ["oldLive"],
      target: {
        value() {
          return "old spelling";
        },
      },
      type: "live",
    } as never),
  ).rejects.toThrow(/require "capability"/);
});

test("Live capability values may have a domain member named capability", async () => {
  const marker = crypto.randomUUID();

  using providerSession = withItxSession();
  using providerItx = providerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = providerItx.projects.create({ slug: `capability-field-live-${marker}` });
  const { projectId } = await project.__describe();

  using _toolsProvision = await project.provideCapability({
    path: ["tools"],
    type: "live",
    capability: {
      capability: {
        echo(input: string) {
          return { input, marker, via: "domain-field" };
        },
      },
      status() {
        return { marker, via: "root-target" };
      },
    },
  });

  using callerSession = withItxSession();
  using callerItx = callerSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      principal: "alice",
      projectScopes: [projectId],
      type: "user",
    },
  });
  using callerProject = callerItx.projects.get(projectId);

  // @ts-expect-error - dynamic capability root
  expect(await callerProject.tools.status()).toEqual({ marker, via: "root-target" });
  // @ts-expect-error - dynamic capability root
  expect(await callerProject.tools.capability.echo("ok")).toEqual({
    input: "ok",
    marker,
    via: "domain-field",
  });
});

test("Live bare function capabilities survive provideCapability return", async () => {
  const marker = crypto.randomUUID();

  using providerSession = withItxSession();
  using providerItx = providerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = providerItx.projects.create({ slug: `bare-function-live-${marker}` });
  const { projectId } = await project.__describe();

  using _addProvision = await project.provideCapability({
    path: ["add"],
    type: "live",
    capability: (a: number, b: number) => ({ marker, sum: a + b }),
  });

  using callerSession = withItxSession();
  using callerItx = callerSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      principal: "alice",
      projectScopes: [projectId],
      type: "user",
    },
  });
  using callerProject = callerItx.projects.get(projectId);

  // @ts-expect-error - dynamic capability root
  expect(await callerProject.add(20, 22)).toEqual({ marker, sum: 42 });
});

test("Top-level RpcTarget live capabilities dispatch by member path", async () => {
  class MathSdk extends RpcTarget {
    add(a: number, b: number) {
      return a + b;
    }
  }
  const marker = crypto.randomUUID();

  using providerSession = withItxSession();
  using providerItx = providerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = providerItx.projects.create({ slug: `rpc-target-live-${marker}` });
  const { projectId } = await project.__describe();

  using _mathProvision = await project.provideCapability({
    path: ["math"],
    type: "live",
    capability: new MathSdk(),
  });

  using callerSession = withItxSession();
  using callerItx = callerSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      principal: "alice",
      projectScopes: [projectId],
      type: "user",
    },
  });
  using callerProject = callerItx.projects.get(projectId);

  // @ts-expect-error - dynamic capability root
  expect(await callerProject.math.add(20, 22)).toBe(42);
});

test("RpcTarget live capabilities can dispatch through nested RpcTarget getters", async () => {
  const marker = crypto.randomUUID();

  class ChatSdk extends RpcTarget {
    postMessage(input: { channel: string; text: string }) {
      return {
        input,
        marker,
        via: "nested-rpc-target-getter",
      };
    }
  }

  class SlackSdk extends RpcTarget {
    get chat() {
      return new ChatSdk();
    }

    invokeCapability() {
      throw new Error("flattened dispatch should not be used in normal dispatch mode");
    }
  }

  using providerSession = withItxSession();
  using providerItx = providerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = providerItx.projects.create({ slug: `nested-rpc-target-live-${marker}` });
  const { projectId } = await project.__describe();

  using _slackProvision = await project.provideCapability({
    path: ["slackSdk"],
    type: "live",
    capability: new SlackSdk(),
  });

  using callerSession = withItxSession();
  using callerItx = callerSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      principal: "alice",
      projectScopes: [projectId],
      type: "user",
    },
  });
  using callerProject = callerItx.projects.get(projectId);

  // @ts-expect-error - dynamic capability root
  expect(await callerProject.slackSdk.chat.postMessage({ channel: "C123", text: "hi" })).toEqual({
    input: { channel: "C123", text: "hi" },
    marker,
    via: "nested-rpc-target-getter",
  });
});

test("Flattened live capabilities receive the remaining member path", async () => {
  const marker = crypto.randomUUID();

  class Carrier extends RpcTarget {
    invokeCapability({ args, path }: { args: unknown[]; path: string[] }) {
      return { args, marker, path };
    }
  }

  using providerSession = withItxSession();
  using providerItx = providerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = providerItx.projects.create({ slug: `path-call-live-${marker}` });
  const { projectId } = await project.__describe();

  using _carrierProvision = await project.provideCapability({
    path: ["carrier"],
    flattenNestedPaths: true,
    type: "live",
    capability: new Carrier(),
  });

  using callerSession = withItxSession();
  using callerItx = callerSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      principal: "alice",
      projectScopes: [projectId],
      type: "user",
    },
  });
  using callerProject = callerItx.projects.get(projectId);

  // @ts-expect-error - dynamic capability root
  expect(await callerProject.carrier.tools.echo("hello")).toEqual({
    args: ["hello"],
    marker,
    path: ["tools", "echo"],
  });
});

test("Successful live capability replacement uses the new target", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `replace-live-${marker}` });

  using _oldProvision = await project.provideCapability({
    path: ["replaceProbe"],
    type: "live",
    capability: {
      value() {
        return `old:${marker}`;
      },
    },
  });

  // @ts-expect-error - dynamic capability root
  expect(await project.replaceProbe.value()).toBe(`old:${marker}`);

  using _newProvision = await project.provideCapability({
    path: ["replaceProbe"],
    type: "live",
    capability: {
      value() {
        return `new:${marker}`;
      },
    },
  });
  // @ts-expect-error - dynamic capability root
  expect(await project.replaceProbe.value()).toBe(`new:${marker}`);
});

test("itx expression replacement records the recipe without evaluating it", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `failed-replace-live-${marker}` });

  using _provision = await project.provideCapability({
    path: ["replaceProbe"],
    type: "live",
    capability: {
      value() {
        return `old:${marker}`;
      },
    },
  });

  using _replacement = await project.provideCapability({
    expression: ["workers", ["get", { source: { files: { type: "inline" } }, type: "stateless" }]],
    path: ["replaceProbe"],
    type: "itx-expression",
  });
  const description = await project.__describe();
  expect(description).toMatchObject({
    capabilities: expect.arrayContaining([
      expect.objectContaining({
        path: ["replaceProbe"],
        type: "itx-expression",
      }),
    ]),
  });

  // @ts-expect-error - dynamic capability root
  await expect(project.replaceProbe.value()).rejects.toThrow();
});

test("Authenticated project can provide the Slack SDK as nested dotted functions", async () => {
  const mock = await startMockSlack();
  try {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });

    using project = itx.projects.create({ slug: "slack-project" });
    const description = await project.__describe();

    const slack = new WebClient("xoxb-not-a-real-token", {
      retryConfig: { retries: 0 },
      slackApiUrl: mock.url,
    });

    using provision = await project.provideCapability({
      path: ["slackSdk"],
      flattenNestedPaths: true,
      type: "live",
      capability: new PathFunctionTarget(slack),
    });

    using callerSession = withItxSession();
    using callerItx = callerSession.authenticate({
      type: "impersonate",
      secret: adminSecret(),
      token: {
        projectScopes: [description.projectId],
        type: "user",
        principal: "alice",
      },
    });
    using callerProject = callerItx.projects.get(description.projectId);

    // @ts-expect-error - dynamic capability root
    const posted = await callerProject.slackSdk.chat.postMessage({
      channel: "C123",
      text: "hi from itx",
    });
    expect(posted).toMatchObject({
      channel: "C123",
      message: { text: "hi from itx" },
      ok: true,
      via: "mock-slack-api",
    });

    // @ts-expect-error - dynamic capability root
    const users = await callerProject.slackSdk.users.list();
    expect(users).toMatchObject({
      members: [
        { id: "U1", name: "ada" },
        { id: "U2", name: "grace" },
      ],
      ok: true,
      via: "mock-slack-api",
    });
    expect(mock).toMatchObject({
      calls: expect.arrayContaining(["chat.postMessage", "users.list"]),
    });

    await provision.revoke();
    await expect(
      // @ts-expect-error - dynamic capability root
      callerProject.slackSdk.chat.postMessage({ channel: "C123", text: "after revoke" }),
    ).rejects.toThrow(/no capability "slackSdk.chat.postMessage"/);
  } finally {
    await mock.close();
  }
});
