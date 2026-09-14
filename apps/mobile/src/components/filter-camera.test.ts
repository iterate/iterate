import { expect, test } from "vitest";
import FilterCamera from "./filter-camera.tsx";

test("a project filter keeps its method state while the native recording clock updates", async () => {
  using camera = filterCamera({
    source: `({ label: "Counter", emoji: "🧮", draw({ctx}) {
      this.state ||= {frames: 0};
      ctx.fillText(String(++this.state.frames), 0, 0);
    } })`,
  });
  camera.update({ facing: "back" });
  camera.requests[0].resolve(mediaStream());
  await camera.settle();
  expect(camera.drawnText).toEqual(["1"]);
  camera.tick();
  camera.update({ dynamicFilters: structuredClone(camera.instance.props.dynamicFilters) });
  camera.tick();
  expect(camera.drawnText).toEqual(["1", "2", "3"]);
  camera.update({
    dynamicFilters: [
      {
        ...camera.instance.props.dynamicFilters[0],
        source: camera.instance.props.dynamicFilters[0].source.replace("frames: 0", "frames: 10"),
      },
    ],
  });
  camera.tick();
  expect(camera.drawnText).toEqual(["1", "2", "3", "11"]);
});

test("a malformed project filter reports its settings error without crashing the camera", async () => {
  using camera = filterCamera({ source: '({label: "Good", emoji: "G", draw() {}})' });
  camera.update({
    facing: "back",
    dynamicFilters: [
      {
        id: camera.instance.props.filterId,
        source: '({label: "Bad", emoji: "B", actions: {}, draw() {}})',
      },
    ],
  });
  expect(() => camera.instance.render()).not.toThrow();
  camera.requests[0].resolve(mediaStream());
  await camera.settle();
  expect(camera.instance.state).toMatchObject({
    status: "live",
    filterError: expect.stringContaining("actions"),
  });
});

test("camera flips stop superseded acquisitions even when devices respond out of order", async () => {
  const first = mediaStream();
  const second = mediaStream();
  {
    using camera = filterCamera({ source: '({label: "Camera", emoji: "C", draw() {}})' });
    camera.update({ facing: "back" });
    camera.update({ facing: "front" });
    camera.requests[1].resolve(second);
    await camera.settle();
    camera.requests[0].resolve(first);
    await camera.settle();
    expect(camera.video.srcObject).toBe(second);
    expect(first.track).toMatchObject({ stopped: true });
    expect(second.track).toMatchObject({ stopped: false });
  }
  expect(second.track).toMatchObject({ stopped: true });
});

test("denying microphone permission still allows filtered photos, but not silent video recordings", async () => {
  using camera = filterCamera({ source: '({label: "Photo", emoji: "P", draw() {}})' });
  camera.update({ facing: "back" });
  camera.requests[0].reject(new DOMException("Microphone denied", "NotAllowedError"));
  await camera.settle();
  expect(camera.requests).toHaveLength(2);
  expect(camera.requests[1].constraints).toMatchObject({ audio: false });
  camera.requests[1].resolve(mediaStream());
  await camera.settle();
  expect(camera.instance.state).toMatchObject({ status: "live" });
  camera.update({ command: { seq: 1, type: "start-recording" } });
  await camera.settle();
  expect(camera.errors).toEqual([expect.stringContaining("microphone")]);
});

// The host's public React lifecycle/bridge callbacks run against controlled
// browser devices. No MediaPipe inference or real recording is simulated:
// these tests cover ownership and project-code execution, not WebKit quality.
function filterCamera({ source }: { source: string }) {
  const requests: {
    constraints: MediaStreamConstraints;
    resolve: (stream: any) => void;
    reject: (error: Error) => void;
  }[] = [];
  const drawnText: string[] = [];
  const errors: string[] = [];
  const ctx = {
    setTransform() {},
    drawImage() {},
    fillText: (text: string) => drawnText.push(text),
  };
  const video = {
    readyState: 2,
    videoWidth: 640,
    videoHeight: 480,
    srcObject: null as any,
    play: async () => {},
  };
  let tick = () => {};
  const globals = {
    document: {
      createElement: (tag: string) => (tag === "video" ? video : { getContext: () => ctx }),
    },
    navigator: {
      mediaDevices: {
        getUserMedia: (constraints: MediaStreamConstraints) =>
          new Promise((resolve, reject) => requests.push({ constraints, resolve, reject })),
      },
    },
    localStorage: { getItem: () => null },
    cancelAnimationFrame: () => {},
    requestAnimationFrame: (callback: () => void) => {
      tick = callback;
      return 1;
    },
    window: { devicePixelRatio: 1, innerWidth: 400, innerHeight: 800 },
  };
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  const instance = new FilterCamera({
    facing: "front",
    filterId: "project:/repos/notes:counter",
    dynamicFilters: [{ id: "project:/repos/notes:counter", source }],
    command: null,
    onPhoto: async () => {},
    onVideo: async () => {},
    onCaptureError: async (message: string) => {
      errors.push(message);
    },
  });
  // React owns these operations in the WebView; apply its synchronous state
  // updates here without requiring a DOM renderer for the controlled canvas.
  instance.setState = (update: any) => Object.assign(instance.state, update);
  instance.forceUpdate = () => {};
  const canvas = { width: 400, height: 800, getContext: () => ctx };
  const rendered: any = instance.render();
  rendered.props.children[1].props.ref(canvas);
  return {
    instance,
    requests,
    drawnText,
    errors,
    video,
    tick: () => tick(),
    update(props: Partial<FilterCamera["props"]>) {
      const previous = instance.props;
      Object.assign(instance, { props: { ...previous, ...props } });
      instance.componentDidUpdate(previous);
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    [Symbol.dispose]() {
      instance.componentWillUnmount();
      for (const key of Object.keys(globals)) {
        if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function mediaStream() {
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  return { track, getAudioTracks: () => [], getTracks: () => [track] };
}
