"use dom";

// The live filter pipeline, hosted in a WebView as an Expo DOM component
// (same pattern as code-editor.tsx). getUserMedia → hidden <video> → canvas
// draw loop, with MediaPipe FaceLandmarker (Apache-2.0, loaded from the
// jsdelivr CDN at runtime) supplying face geometry. The native side drives
// captures through the marshaled `command` prop; captured bytes go back as
// base64 through the async result props.
//
// Why a WebView and not a camera frame processor: a frame processor means a
// new native module and a new EAS dev-client build. This keeps filters pure
// JS — the point of the exercise (see tasks/mobile-camera-filters.md).

import { Component } from "react";
import { FaceLandmarker } from "@mediapipe/tasks-vision";
import { base64ToUint8Array } from "../lib/encoding.ts";
import {
  FACE_LANDMARKER_MODEL_GZ,
  MEDIAPIPE_WASM_GZ,
  MEDIAPIPE_WASM_LOADER_JS_GZ,
} from "../lib/filters/mediapipe-assets.generated.ts";
import { FILTER_DRAWERS, type FilterFrameArgs } from "../lib/filters/definitions.ts";
import { FILTERED_CLIP_MAX_SECONDS } from "../lib/filters/picker.ts";
import {
  coverTransform,
  faceGeometryFromLandmarks,
  fallbackFaceGeometry,
  type FaceGeometry,
} from "../lib/filters/face-geometry.ts";

// NOTE: "use dom" modules only support a single default export — runtime
// named exports break the Metro bundle (CI-caught). Shared values live in
// ../lib/filters/definitions.ts; type-only exports are erased and fine.
export type FilterCameraCommand = {
  /** Monotonic; a new seq triggers the action exactly once. */
  seq: number;
  type: "snap" | "start-recording" | "stop-recording";
};

type Props = {
  dom?: import("expo/dom").DOMProps;
  filterId: string;
  facing: "front" | "back";
  command: FilterCameraCommand | null;
  onPhoto: (photo: { base64: string; width: number; height: number }) => Promise<void>;
  onVideo: (video: { base64: string; mimeType: string; durationSeconds: number }) => Promise<void>;
  onCaptureError: (message: string) => Promise<void>;
};

type State = { status: "starting" | "live" | "error"; message: string | null };

export default class FilterCamera extends Component<Props, State> {
  state: State = { status: "starting", message: null };

  #canvas: HTMLCanvasElement | null = null;
  #frameCanvas = document.createElement("canvas");
  #video = document.createElement("video");
  #stream: MediaStream | null = null;
  #landmarker: FaceLandmarker | null = null;
  #trackerError: string | null = null;
  #raf = 0;
  #disposed = false;
  #backgroundIndex = 0;
  #handledCommandSeq = 0;
  #recorder: MediaRecorder | null = null;
  #recorderChunks: Blob[] = [];
  #recordingStartedAt = 0;
  #recordingMaxTimer: ReturnType<typeof setTimeout> | null = null;

  componentDidMount() {
    this.#video.playsInline = true;
    this.#video.muted = true;
    void this.#start();
    void this.#loadFaceTracker();
  }

  componentDidUpdate(previous: Props) {
    if (previous.facing !== this.props.facing) void this.#start();
    const command = this.props.command;
    if (command && command.seq !== this.#handledCommandSeq) {
      this.#handledCommandSeq = command.seq;
      void this.#run(command);
    }
  }

  componentWillUnmount() {
    this.#disposed = true;
    cancelAnimationFrame(this.#raf);
    if (this.#recordingMaxTimer) clearTimeout(this.#recordingMaxTimer);
    this.#recorder?.stop();
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#landmarker?.close();
  }

  async #start() {
    try {
      this.#stream?.getTracks().forEach((track) => track.stop());
      // Audio is requested up front so a recording started later already has
      // a live mic track to mix in.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: this.props.facing === "front" ? "user" : "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: true,
      });
      if (this.#disposed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.#stream = stream;
      this.#video.srcObject = stream;
      await this.#video.play();
      this.setState({ status: "live", message: null });
      cancelAnimationFrame(this.#raf);
      this.#loop();
    } catch (error) {
      this.setState({
        status: "error",
        message: `Camera unavailable in the filter pipeline: ${String(
          (error as Error).message || error,
        )}`,
      });
    }
  }

  // The whole tracking runtime ships in the app (wasm + model, gzipped in
  // mediapipe-assets.generated.ts) and is handed to MediaPipe as blob URLs /
  // bytes: release builds host DOM components on file:// pages, where
  // cross-origin module imports and fetches are unreliable — an earlier
  // CDN-loading version of this hung forever on-device.
  async #loadFaceTracker() {
    try {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("DecompressionStream unavailable (needs iOS 16.4+)");
      }
      const [loaderJs, wasmBinary, model] = await Promise.all([
        gunzip(MEDIAPIPE_WASM_LOADER_JS_GZ),
        gunzip(MEDIAPIPE_WASM_GZ),
        gunzip(FACE_LANDMARKER_MODEL_GZ),
      ]);
      const fileset = {
        wasmLoaderPath: URL.createObjectURL(new Blob([loaderJs], { type: "text/javascript" })),
        wasmBinaryPath: URL.createObjectURL(new Blob([wasmBinary], { type: "application/wasm" })),
      };
      const create = (delegate: "GPU" | "CPU") =>
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: model, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
        });
      // WKWebView WebGL2 support varies by OS version; CPU inference is fine
      // for one face.
      const landmarker = await create("GPU").catch(() => create("CPU"));
      if (this.#disposed) {
        landmarker.close();
        return;
      }
      this.#landmarker = landmarker;
      this.forceUpdate();
    } catch (error) {
      // Filters keep running on the fallback face oval; the pill in render()
      // says exactly what broke.
      this.#trackerError = String((error as Error).message || error);
      this.forceUpdate();
    }
  }

  #loop = () => {
    if (this.#disposed) return;
    this.#raf = requestAnimationFrame(this.#loop);
    const canvas = this.#canvas;
    const video = this.#video;
    if (!canvas || video.readyState < 2 || !video.videoWidth) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(window.innerWidth * pixelRatio);
    const height = Math.round(window.innerHeight * pixelRatio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    if (this.#frameCanvas.width !== width) this.#frameCanvas.width = width;
    if (this.#frameCanvas.height !== height) this.#frameCanvas.height = height;

    const mirrored = this.props.facing === "front";
    const t = coverTransform({
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      canvasWidth: width,
      canvasHeight: height,
      mirrored,
    });

    // One cover-mapped (and, for the front camera, mirrored) copy of the
    // frame per tick; filters sample from this so they never deal with
    // mirroring or aspect ratios. The centered cover-crop is horizontally
    // symmetric, so the mirror transform reuses the same offsets.
    const fctx = this.#frameCanvas.getContext("2d")!;
    fctx.setTransform(mirrored ? -1 : 1, 0, 0, 1, mirrored ? width : 0, 0);
    fctx.drawImage(
      video,
      t.offsetX,
      t.offsetY,
      video.videoWidth * t.scale,
      video.videoHeight * t.scale,
    );
    fctx.setTransform(1, 0, 0, 1, 0, 0);

    let face: FaceGeometry | null = null;
    if (this.#landmarker) {
      const result = this.#landmarker.detectForVideo(video, performance.now());
      const landmarks = result.faceLandmarks[0];
      if (landmarks) face = faceGeometryFromLandmarks(landmarks, t);
    }
    face = face || fallbackFaceGeometry(width, height);

    const draw = filterDrawerById(this.props.filterId);
    const ctx = canvas.getContext("2d")!;
    draw({
      ctx,
      frame: this.#frameCanvas,
      width,
      height,
      face,
      backgroundIndex: this.#backgroundIndex,
      timeMs: performance.now(),
    });
  };

  async #run(command: FilterCameraCommand) {
    try {
      if (command.type === "snap") await this.#snap();
      if (command.type === "start-recording") this.#startRecording();
      if (command.type === "stop-recording") this.#recorder?.stop();
    } catch (error) {
      await this.props.onCaptureError(String((error as Error).message || error));
    }
  }

  async #snap() {
    const canvas = this.#canvas;
    if (!canvas || this.state.status !== "live") throw new Error("The filter camera is not live");
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("toBlob returned nothing"))),
        "image/jpeg",
        0.85,
      );
    });
    await this.props.onPhoto({
      base64: await blobToBase64(blob),
      width: canvas.width,
      height: canvas.height,
    });
  }

  #startRecording() {
    const canvas = this.#canvas;
    if (!canvas || this.state.status !== "live") throw new Error("The filter camera is not live");
    if (this.#recorder) return;
    const stream = canvas.captureStream(30);
    for (const track of this.#stream?.getAudioTracks() || []) stream.addTrack(track);
    const mimeType = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find((candidate) =>
      MediaRecorder.isTypeSupported(candidate),
    );
    if (!mimeType) throw new Error("MediaRecorder supports no usable format here");
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
    this.#recorder = recorder;
    this.#recorderChunks = [];
    this.#recordingStartedAt = Date.now();
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.#recorderChunks.push(event.data);
    };
    recorder.onstop = () => {
      const durationSeconds = (Date.now() - this.#recordingStartedAt) / 1000;
      const blob = new Blob(this.#recorderChunks, { type: mimeType });
      this.#recorder = null;
      this.#recorderChunks = [];
      if (this.#recordingMaxTimer) clearTimeout(this.#recordingMaxTimer);
      if (this.#disposed) return;
      void blobToBase64(blob)
        .then((base64) => this.props.onVideo({ base64, mimeType, durationSeconds }))
        .catch((error) => this.props.onCaptureError(String((error as Error).message || error)));
    };
    recorder.start();
    // Hard cap so the base64 bridge payload stays bounded; the native side
    // shows the same cap in its timer.
    this.#recordingMaxTimer = setTimeout(
      () => this.#recorder?.stop(),
      FILTERED_CLIP_MAX_SECONDS * 1000,
    );
  }

  render() {
    const trackerLive = this.#landmarker !== null;
    return (
      <main>
        <style>{styles}</style>
        <canvas
          ref={(canvas) => {
            this.#canvas = canvas;
          }}
          // Tapping the scene is the filters' interactivity: cycles the
          // background (advances the card, for flashcards).
          onClick={() => {
            this.#backgroundIndex += 1;
          }}
        />
        {this.state.status === "starting" ? (
          <div className="pill">Warming up the camera…</div>
        ) : null}
        {this.state.status === "live" && !trackerLive && this.#trackerError === null ? (
          <div className="pill">Loading face tracking…</div>
        ) : null}
        {this.state.status === "live" && this.#trackerError !== null ? (
          <div className="pill error">
            Face tracking failed — using a guessed face. {this.#trackerError}
          </div>
        ) : null}
        {this.state.status === "error" ? (
          <div className="pill error">{this.state.message}</div>
        ) : null}
      </main>
    );
  }
}

function filterDrawerById(id: string): (args: FilterFrameArgs) => void {
  const draw = FILTER_DRAWERS[id];
  if (!draw) throw new Error(`Unknown filter: ${id}`);
  return draw;
}

async function gunzip(base64: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([base64ToUint8Array(base64)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read captured bytes"));
    reader.onload = () => {
      // result is a data: uri; the attachment pipeline wants bare base64.
      const dataUri = String(reader.result);
      resolve(dataUri.slice(dataUri.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

const styles = `
  html, body, main { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
  canvas { width: 100vw; height: 100vh; display: block; }
  .pill {
    position: fixed;
    bottom: calc(140px + env(safe-area-inset-bottom));
    left: 50%;
    transform: translateX(-50%);
    max-width: 80vw;
    background: rgba(11, 11, 15, 0.7);
    color: #fff;
    font: 12px -apple-system, sans-serif;
    padding: 6px 12px;
    border-radius: 999px;
    text-align: center;
  }
  .pill.error { background: rgba(180, 30, 30, 0.85); }
`;
