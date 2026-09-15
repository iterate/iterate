import { expect, test } from "vitest";
import FilterCamera from "./filter-camera.tsx";

test("capture waits for the active filter's image, then uses it without a second shutter press", async () => {
  using camera = filterCamera({
    source: `({label: "Image", emoji: "I", draw({ctx, helpers}) {
    const image = helpers.cachedImage("capture-test", "https://mobile.iterate.com/filter-assets/test.png");
    if (image) ctx.drawImage(image, 0, 0);
  }})`,
  });
  camera.update({ facing: "back" });
  camera.requests[0].resolve(mediaStream());
  await camera.settle();
  expect(camera.instance.state).toMatchObject({ assetsLoading: true });
  expect(camera.images).toHaveLength(1);
  expect(camera.images[0].crossOrigin).toBe("anonymous");
  camera.update({ command: { seq: 1, type: "snap" } });
  await camera.settle();
  expect(camera.photos).toHaveLength(0);
  camera.images[0].naturalWidth = 100;
  camera.images[0].complete = true;
  camera.images[0].onload();
  await camera.settle();
  expect(camera.instance.state).toMatchObject({ assetsLoading: false });
  expect(camera.photos).toHaveLength(1);
  expect(camera.drawnImages).toContain(camera.images[0]);
  expect(camera.errors).toEqual([]);
});

test("a failed image gives an actionable error and does not block an unrelated filter", async () => {
  using camera = filterCamera({
    source: `({label: "Image", emoji: "I", draw({helpers}) {
    helpers.cachedImage("failed-test", "https://mobile.iterate.com/filter-assets/failed.png");
  }})`,
  });
  camera.update({ facing: "back" });
  camera.requests[0].resolve(mediaStream());
  await camera.settle();
  camera.images[0].onerror();
  camera.tick();
  expect(camera.instance.state).toMatchObject({
    assetsLoading: false,
    assetError: "Could not load image: failed-test",
  });
  camera.update({ command: { seq: 1, type: "snap" } });
  await camera.settle();
  expect(camera.photos).toHaveLength(0);
  expect(camera.errors).toEqual(["Could not load image: failed-test"]);
  camera.update({
    dynamicFilters: [
      { id: camera.instance.props.filterId, source: '({label: "Plain", emoji: "P", draw() {}})' },
    ],
  });
  camera.update({ command: { seq: 2, type: "snap" } });
  await camera.settle();
  expect(camera.instance.state).toMatchObject({ assetsLoading: false, assetError: null });
  expect(camera.photos).toHaveLength(1);
});

test("stopping while video assets load cancels the pending start", async () => {
  using camera = filterCamera({
    source: `({label: "Image", emoji: "I", draw({helpers}) {
    helpers.cachedImage("stop-test", "https://mobile.iterate.com/filter-assets/stop.png");
  }})`,
  });
  camera.update({ facing: "back" });
  camera.requests[0].resolve(mediaStream());
  await camera.settle();
  camera.update({ command: { seq: 1, type: "start-recording" } });
  await camera.settle();
  camera.update({ command: { seq: 2, type: "stop-recording" } });
  await camera.settle();
  expect(camera.errors).toEqual(["Recording canceled while the filter was loading"]);
  camera.images[0].naturalWidth = 100;
  camera.images[0].onload();
  await camera.settle();
  expect(camera.errors).toHaveLength(1);
  expect(camera.instance.state).toMatchObject({ recording: false });
});

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

test("a shutter press during camera warmup waits for real pixels without a second press", async () => {
  using camera = filterCamera({ source: '({label: "Photo", emoji: "P", draw() {}})' });
  camera.update({ facing: "back" });
  camera.update({ command: { seq: 1, type: "snap" } });
  await camera.settle();
  expect(camera.photos).toEqual([]);
  expect(camera.errors).toEqual([]);
  camera.video.readyState = 0;
  camera.requests[0].resolve(mediaStream());
  await camera.settle();
  expect(camera.photos).toEqual([]);
  camera.video.readyState = 2;
  camera.tick();
  await camera.settle();
  expect(camera.photos).toHaveLength(1);
  expect(camera.errors).toEqual([]);
});

test("camera denial settles a shutter that was waiting for warmup", async () => {
  using camera = filterCamera({ source: '({label: "Photo", emoji: "P", draw() {}})' });
  camera.update({ facing: "back" });
  camera.update({ command: { seq: 1, type: "snap" } });
  await camera.settle();
  camera.requests[0].reject(new DOMException("Camera disconnected", "NotReadableError"));
  await camera.settle();
  expect(camera.photos).toEqual([]);
  expect(camera.errors).toEqual([expect.stringContaining("Camera disconnected")]);
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
  const images: any[] = [];
  const photos: any[] = [];
  const drawnImages: any[] = [];
  const ctx = {
    setTransform() {},
    drawImage: (image: any) => drawnImages.push(image),
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
    Image: class {
      complete = false;
      naturalWidth = 0;
      constructor() {
        images.push(this);
      }
    },
    FileReader: class {
      result = "data:image/jpeg;base64,AQID";
      onload = () => {};
      readAsDataURL() {
        this.onload();
      }
    },
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
    onPhoto: async (photo) => {
      photos.push(photo);
    },
    onVideo: async () => {},
    onCaptureError: async (message: string) => {
      errors.push(message);
    },
  });
  // React owns these operations in the WebView; apply its synchronous state
  // updates here without requiring a DOM renderer for the controlled canvas.
  instance.setState = (update: any) => Object.assign(instance.state, update);
  instance.forceUpdate = () => {};
  const canvas = {
    width: 400,
    height: 800,
    getContext: () => ctx,
    toBlob: (callback: any) => callback(new Blob([new Uint8Array([1, 2, 3])])),
  };
  const rendered: any = instance.render();
  rendered.props.children[1].props.ref(canvas);
  return {
    instance,
    requests,
    drawnText,
    errors,
    images,
    photos,
    drawnImages,
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
