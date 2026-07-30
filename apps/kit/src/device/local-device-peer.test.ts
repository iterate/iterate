import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "@iterate-com/capnweb";
import { WebSocketPair } from "captun";
import { afterEach, describe, expect, test } from "vitest";
import { ITERATE_KIT_PCM_SUBPROTOCOL } from "../voice/device-pcm-proxy.ts";
import type { M5StickS3 } from "./m5sticks3-contract.ts";
import { LocalDevicePeer, type LocalDevicePeerRoot } from "./local-device-peer.ts";
import { LocalDevicePeerServer } from "./local-device-peer-server.ts";

const projectId = "prj_local_device_test";
const projectSecret = "itxk_local-device-test-secret";
const mountPath = ["kit", "m5sticks3"] as const;

class PushToTalkTarget extends RpcTarget {
  readonly #events: string[];

  constructor(events: string[]) {
    super();
    this.#events = events;
  }

  start() {
    this.#events.push("started");
    return true;
  }

  stop() {
    this.#events.push("stopped");
    return true;
  }
}

class TestM5StickS3Target extends RpcTarget {
  readonly #pushToTalk: PushToTalkTarget;

  constructor(events: string[]) {
    super();
    this.#pushToTalk = new PushToTalkTarget(events);
  }

  __describe() {
    return {
      children: {
        pushToTalk: {
          start: "Begin push-to-talk capture.",
          stop: "End push-to-talk capture.",
        },
      },
      instructions: "Local M5StickS3 test target.",
    };
  }

  get pushToTalk() {
    return this.#pushToTalk;
  }
}

class PeerFixture {
  readonly #clientSocket: WebSocket;
  readonly #serverSocket: WebSocket;
  readonly #serverRemoteMain: RpcStub<M5StickS3>;
  readonly deviceEvents: string[] = [];
  readonly peer = new LocalDevicePeer({
    mountPath,
    projectId,
    projectSecret,
  });
  readonly root: RpcStub<LocalDevicePeerRoot>;

  constructor() {
    const pair = new WebSocketPair();
    this.#serverSocket = pair[0];
    this.#clientSocket = pair[1];
    pair[0].accept();
    pair[1].accept();

    this.#serverRemoteMain = newWebSocketRpcSession<M5StickS3>(
      this.#serverSocket,
      this.peer.createRpcRoot(),
    );
    this.root = newWebSocketRpcSession<LocalDevicePeerRoot>(
      this.#clientSocket,
      new TestM5StickS3Target(this.deviceEvents),
    );
  }

  async authenticate() {
    return this.root.authenticate({
      projectId,
      secret: projectSecret,
      type: "project-secret",
    });
  }

  [Symbol.dispose]() {
    this.root[Symbol.dispose]();
    this.#serverRemoteMain[Symbol.dispose]();
    this.#clientSocket.close();
    this.#serverSocket.close();
    this.peer[Symbol.dispose]();
  }
}

function waitForMessages(socket: WebSocket, count: number) {
  return new Promise<unknown[]>((resolve) => {
    const messages: unknown[] = [];
    const receive = (event: MessageEvent) => {
      messages.push(event.data);
      if (messages.length === count) {
        socket.removeEventListener("message", receive);
        resolve(messages);
      }
    };
    socket.addEventListener("message", receive);
  });
}

describe("local device Cap'n Web peer", () => {
  const fixtures: PeerFixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      fixture[Symbol.dispose]();
    }
  });

  function fixture() {
    const value = new PeerFixture();
    fixtures.push(value);
    return value;
  }

  test("retains a mounted device after provideCapability arguments are released", async () => {
    const current = fixture();
    await using session = await current.authenticate();
    await using project = await session.projects.get(projectId);
    await using provision = await project.provideCapability({
      capability: new TestM5StickS3Target(current.deviceEvents),
      path: [...mountPath],
      type: "live",
    });

    const mounted = await current.peer.waitForMount();
    await expect(mounted.device.__describe()).resolves.toMatchObject({
      instructions: "Local M5StickS3 test target.",
    });
    await expect(mounted.device.pushToTalk.start()).resolves.toBe(true);
    await expect(mounted.device.pushToTalk.stop()).resolves.toBe(true);
    expect(current.deviceEvents).toEqual(["started", "stopped"]);

    await provision.revoke();
    await expect(mounted.disconnected).resolves.toBe("revoked");
    expect(current.peer.activeMount).toBeUndefined();
  });

  test("rejects credential, project, and mount-contract drift explicitly", async () => {
    const current = fixture();
    await expect(
      current.root.authenticate({
        projectId,
        secret: "wrong",
        type: "project-secret",
      }),
    ).rejects.toThrow("project credentials");

    await using session = await current.authenticate();
    await expect(session.projects.get("prj_wrong")).rejects.toThrow("project reference");
    await using project = await session.projects.get(projectId);
    await expect(
      project.provideCapability({
        capability: new TestM5StickS3Target(current.deviceEvents),
        path: ["devices", "m5sticks3"],
        type: "live",
      }),
    ).rejects.toThrow("mount path");
  });

  test("serves only health and the Cap'n Web WebSocket endpoint", async () => {
    const current = fixture();
    using server = new LocalDevicePeerServer(current.peer);

    expect(server.fetch(new Request("https://local.invalid/health"))).toMatchObject({
      status: 200,
    });
    await expect(
      (await server.fetch(new Request("https://local.invalid/health"))).json(),
    ).resolves.toEqual({ mounted: false, status: "ready" });
    expect(server.fetch(new Request("https://local.invalid/api"))).toMatchObject({ status: 426 });
    expect(server.fetch(new Request("https://local.invalid/not-found"))).toMatchObject({
      status: 404,
    });

    const response = await server.fetch(
      new Request("https://local.invalid/api", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect((response as Response & { webSocket?: WebSocket }).webSocket).toBeDefined();
  });

  test("routes an independently authenticated PCM WebSocket without changing the Cap'n Web socket", async () => {
    const current = fixture();
    const providerPair = new WebSocketPair();
    const readySessions: string[] = [];
    providerPair[0].accept();
    providerPair[1].accept();
    using server = new LocalDevicePeerServer(current.peer, {
      connectVoiceProvider: async () => providerPair[0],
      onPcmSessionReady: (session) => readySessions.push(session.id),
      pcmFrameBytes: 640,
    });

    expect(
      await server.fetch(
        new Request("https://local.invalid/pcm", {
          headers: {
            authorization: `Bearer ${projectSecret}`,
            "sec-websocket-protocol": ITERATE_KIT_PCM_SUBPROTOCOL,
            upgrade: "websocket",
            "x-iterate-project-id": projectId,
          },
        }),
      ),
    ).toMatchObject({ status: 200 });
    expect(readySessions).toEqual([`${projectId}:${mountPath.join("/")}`]);
    expect(
      await server.fetch(
        new Request("https://local.invalid/pcm", {
          headers: {
            authorization: "Bearer wrong",
            "sec-websocket-protocol": ITERATE_KIT_PCM_SUBPROTOCOL,
            upgrade: "websocket",
            "x-iterate-project-id": projectId,
          },
        }),
      ),
    ).toMatchObject({ status: 401 });

    const controlResponse = await server.fetch(
      new Request("https://local.invalid/api", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect((controlResponse as Response & { webSocket?: WebSocket }).webSocket).toBeDefined();
    providerPair[1].close();
  });

  test("routes push-to-talk lifecycle events to the matching provider session", async () => {
    const current = fixture();
    const providerPair = new WebSocketPair();
    providerPair[0].accept();
    providerPair[1].accept();
    using server = new LocalDevicePeerServer(current.peer, {
      connectVoiceProvider: async () => providerPair[0],
      pcmFrameBytes: 640,
      pcmInputMode: "push-to-talk",
    });
    const response = await server.fetch(
      new Request("https://local.invalid/pcm", {
        headers: {
          authorization: `Bearer ${projectSecret}`,
          "sec-websocket-protocol": ITERATE_KIT_PCM_SUBPROTOCOL,
          upgrade: "websocket",
          "x-iterate-project-id": projectId,
        },
      }),
    );
    const deviceSocket = (response as Response & { webSocket?: WebSocket & { accept(): void } })
      .webSocket;
    if (!deviceSocket) throw new Error("missing device PCM socket");
    deviceSocket.accept();

    await expect(server.inputStarted()).resolves.toBe(true);
    const controls = waitForMessages(providerPair[1], 2);
    await expect(server.inputStopped()).resolves.toBe(true);
    await expect(
      controls.then((messages) => messages.map((message) => JSON.parse(String(message)))),
    ).resolves.toEqual([{ type: "input_audio_buffer.commit" }, { type: "response.create" }]);

    deviceSocket.close();
    providerPair[1].close();
  });

  test("preserves the exact PCM peer close as structured diagnostic evidence", async () => {
    const current = fixture();
    const providerPair = new WebSocketPair();
    const closeObserved = Promise.withResolvers<unknown>();
    providerPair[0].accept();
    providerPair[1].accept();
    using server = new LocalDevicePeerServer(current.peer, {
      connectVoiceProvider: async () => providerPair[0],
      /*
       * The physical harness used to retain only a generic timeout after a
       * short audible tone. That erased whether the device, provider, or
       * intermediary actually ended the session. This test keeps the
       * structured close contract intact across the server facade so a failed
       * endurance artifact can carry the causal wire evidence.
       */
      onVoiceSocketClose: closeObserved.resolve,
      pcmFrameBytes: 640,
    });
    const response = await server.fetch(
      new Request("https://local.invalid/pcm", {
        headers: {
          authorization: `Bearer ${projectSecret}`,
          "sec-websocket-protocol": ITERATE_KIT_PCM_SUBPROTOCOL,
          upgrade: "websocket",
          "x-iterate-project-id": projectId,
        },
      }),
    );
    const deviceSocket = (response as Response & { webSocket?: WebSocket & { accept(): void } })
      .webSocket;
    if (!deviceSocket) throw new Error("missing device PCM socket");
    deviceSocket.accept();

    providerPair[1].close(4003, "provider-test-close");

    await expect(closeObserved.promise).resolves.toEqual({
      classification: "unexpected",
      code: 4003,
      origin: "provider",
      reason: "provider-test-close",
      wasClean: undefined,
    });
    deviceSocket.close();
  });
});
