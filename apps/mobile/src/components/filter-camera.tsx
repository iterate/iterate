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
import {
  buildFrameArgs,
  evaluateDynamicFilter,
  FILTER_DRAWERS,
  FILTER_MODES,
  type DynamicFilterDefinition,
  type FeatureHit,
  type FilterFrameArgs,
  type MaskStretch,
} from "../lib/filters/definitions.ts";
import { autoCorrelatePitchHz } from "../lib/filters/pitch.ts";
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
  /** Project-authored filters (filters/<name>.filter.js repo files), fetched
   * by the native side and evaluated here — see evaluateDynamicFilter. */
  dynamicFilters: { id: string; source: string }[];
  facing: "front" | "back";
  command: FilterCameraCommand | null;
  onPhoto: (photo: { base64: string; width: number; height: number }) => Promise<void>;
  onVideo: (video: { base64: string; mimeType: string; durationSeconds: number }) => Promise<void>;
  onCaptureError: (message: string) => Promise<void>;
};

type State = {
  status: "starting" | "live" | "error";
  message: string | null;
  /** Transient readout while the user drags a feature's mask looseness. */
  adjustLabel: string | null;
  /** The active filter threw while drawing (project filters especially). */
  filterError: string | null;
  /** Mirrors #recorder so render() can hide chrome (the mode button) that
   * should not appear in recorded clips' UI. */
  recording: boolean;
};

const MASK_STRETCH_KEY = "iterate.filterMaskStretch.v1";

function loadMaskStretch(): MaskStretch {
  // localStorage can be unavailable/empty on file:// pages — defaults win.
  try {
    const raw = localStorage.getItem(MASK_STRETCH_KEY);
    if (raw) return JSON.parse(raw) as MaskStretch;
  } catch {
    // fall through to defaults
  }
  return { eyes: { x: 1, y: 1 }, lips: { x: 1, y: 1 } };
}

export default class FilterCamera extends Component<Props, State> {
  state: State = {
    status: "starting",
    message: null,
    adjustLabel: null,
    filterError: null,
    recording: false,
  };

  #canvas: HTMLCanvasElement | null = null;
  #frameCanvas = document.createElement("canvas");
  #video = document.createElement("video");
  #stream: MediaStream | null = null;
  #landmarker: FaceLandmarker | null = null;
  #trackerError: string | null = null;
  #raf = 0;
  #disposed = false;
  #backgroundIndex = 0;
  #modeIndex = 0;
  // First tracked face after the filter starts: the reference the potato's
  // full head-tracking moves relative to.
  #faceBaseline: { cx: number; cy: number; width: number } | null = null;
  #maskStretch = loadMaskStretch();
  #featureHits: FeatureHit[] = [];
  // Live mic analysis for pitch-driven filters. The context can start
  // suspended under autoplay rules; #onPointerDown re-resumes it.
  #audioContext: AudioContext | null = null;
  #audioAnalyser: AnalyserNode | null = null;
  #audioSamples: Float32Array<ArrayBuffer> | null = null;
  // One in-flight touch: where it started, which feature (if any) it grabbed
  // and that feature's stretch at grab time, and whether it became a drag.
  #pointer: {
    startX: number;
    startY: number;
    hit: FeatureHit | null;
    startStretch: { x: number; y: number };
    dragging: boolean;
  } | null = null;
  #adjustLabelTimer: ReturnType<typeof setTimeout> | null = null;
  // Evaluated project filters, keyed by id; an Error marks a bad source so
  // it is reported once instead of re-thrown every frame.
  #dynamicCache = new Map<string, DynamicFilterDefinition | Error>();
  #handledCommandSeq = 0;
  #recorder: MediaRecorder | null = null;
  #recorderChunks: Blob[] = [];
  #recordingStartedAt = 0;

  componentDidMount() {
    this.#video.playsInline = true;
    this.#video.muted = true;
    void this.#start();
    void this.#loadFaceTracker();
  }

  componentDidUpdate(previous: Props) {
    if (previous.facing !== this.props.facing) void this.#start();
    if (previous.filterId !== this.props.filterId) this.#faceBaseline = null;
    if (previous.dynamicFilters !== this.props.dynamicFilters) this.#dynamicCache.clear();
    const command = this.props.command;
    if (command && command.seq !== this.#handledCommandSeq) {
      this.#handledCommandSeq = command.seq;
      void this.#run(command);
    }
  }

  componentWillUnmount() {
    this.#disposed = true;
    cancelAnimationFrame(this.#raf);
    void this.#audioContext?.close();
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
      this.#setupPitchAnalysis(stream);
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
  #setupPitchAnalysis(stream: MediaStream) {
    try {
      if (stream.getAudioTracks().length === 0) return;
      void this.#audioContext?.close();
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      this.#audioContext = context;
      this.#audioAnalyser = analyser;
      this.#audioSamples = new Float32Array(analyser.fftSize);
      void context.resume();
    } catch {
      // Pitch-driven filters just see null and say "make some noise".
    }
  }

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
    if (face.tracked && this.#faceBaseline === null) {
      this.#faceBaseline = { cx: face.box.cx, cy: face.box.cy, width: face.box.width };
    }
    const baseline = this.#faceBaseline;
    const facePose =
      face.tracked && baseline
        ? {
            dx: face.box.cx - baseline.cx,
            dy: face.box.cy - baseline.cy,
            scale: face.box.width / baseline.width,
          }
        : { dx: 0, dy: 0, scale: 1 };

    let pitchHz: number | null = null;
    if (this.#audioContext && this.#audioAnalyser && this.#audioSamples) {
      this.#audioAnalyser.getFloatTimeDomainData(this.#audioSamples);
      pitchHz = autoCorrelatePitchHz(this.#audioSamples, this.#audioContext.sampleRate);
    }

    const ctx = canvas.getContext("2d")!;
    const featureHits: FeatureHit[] = [];
    const args = buildFrameArgs({
      ctx,
      frame: this.#frameCanvas,
      width,
      height,
      face,
      backgroundIndex: this.#backgroundIndex,
      modeIndex: this.#modeIndex,
      facePose,
      maskStretch: this.#maskStretch,
      featureHits,
      pitchHz,
      timeMs: performance.now(),
    });
    try {
      this.#resolveDrawer()(args);
      if (this.state.filterError !== null) this.setState({ filterError: null });
    } catch (error) {
      // A broken (likely project-authored) filter must not kill the camera:
      // show the plain frame plus the error.
      ctx.drawImage(this.#frameCanvas, 0, 0);
      const message = String((error as Error).message || error);
      if (this.state.filterError !== message) this.setState({ filterError: message });
    }
    this.#featureHits = featureHits;
  };

  /** The active filter's draw function — built-in, or an evaluated project
   * filter (cached; a bad source throws its evaluation error). */
  #resolveDrawer(): (args: FilterFrameArgs) => void {
    const id = this.props.filterId;
    if (FILTER_DRAWERS[id]) return FILTER_DRAWERS[id];
    const dynamic = this.#dynamicDefinition(id);
    if (dynamic instanceof Error) throw dynamic;
    if (dynamic) return dynamic.draw;
    throw new Error(`Unknown filter: ${id}`);
  }

  #dynamicDefinition(id: string): DynamicFilterDefinition | Error | null {
    const entry = this.props.dynamicFilters.find((filter) => filter.id === id);
    if (!entry) return null;
    let cached = this.#dynamicCache.get(id);
    if (!cached) {
      try {
        cached = evaluateDynamicFilter(entry.source);
      } catch (error) {
        cached = error as Error;
      }
      this.#dynamicCache.set(id, cached);
    }
    return cached;
  }

  #modesForActiveFilter(): string[] {
    const dynamic = this.#dynamicDefinition(this.props.filterId);
    if (dynamic && !(dynamic instanceof Error)) return dynamic.modes || [];
    return FILTER_MODES[this.props.filterId] || [];
  }

  /** Pointer position in canvas device pixels (hits are recorded there). */
  #canvasPoint(event: { clientX: number; clientY: number }) {
    const canvas = this.#canvas!;
    const scale = canvas.width / (canvas.clientWidth || 1);
    return { x: event.clientX * scale, y: event.clientY * scale };
  }

  #onPointerDown = (event: React.PointerEvent) => {
    void this.#audioContext?.resume();
    const point = this.#canvasPoint(event);
    let hit: FeatureHit | null = null;
    for (const candidate of this.#featureHits) {
      const distance = Math.hypot(candidate.cx - point.x, candidate.cy - point.y);
      if (distance <= candidate.radius * 1.8) {
        if (!hit || distance < Math.hypot(hit.cx - point.x, hit.cy - point.y)) hit = candidate;
      }
    }
    this.#pointer = {
      startX: event.clientX,
      startY: event.clientY,
      hit,
      startStretch: hit ? { ...this.#maskStretch[hit.kind] } : { x: 1, y: 1 },
      dragging: false,
    };
  };

  #onPointerMove = (event: React.PointerEvent) => {
    const pointer = this.#pointer;
    if (!pointer) return;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;
    if (!pointer.dragging && Math.hypot(dx, dy) < 12) return;
    pointer.dragging = true;
    if (!pointer.hit) return;
    // Right/left widens/narrows the mask; up/down heightens/flattens it.
    // This reshapes the CUTOUT around your feature — it never rescales the
    // sampled image.
    const clamp = (value: number) => Math.min(3, Math.max(0.35, value));
    const stretch = {
      x: clamp(pointer.startStretch.x * (1 + dx / 240)),
      y: clamp(pointer.startStretch.y * (1 - dy / 240)),
    };
    this.#maskStretch = { ...this.#maskStretch, [pointer.hit.kind]: stretch };
    this.setState({
      adjustLabel: `${pointer.hit.kind} mask ${stretch.x.toFixed(2)}× wide / ${stretch.y.toFixed(2)}× tall`,
    });
  };

  #onPointerUp = () => {
    const pointer = this.#pointer;
    this.#pointer = null;
    if (!pointer) return;
    if (!pointer.dragging) {
      // A plain tap: the filters' interactivity — next background/card.
      this.#backgroundIndex += 1;
      return;
    }
    if (pointer.hit) {
      try {
        localStorage.setItem(MASK_STRETCH_KEY, JSON.stringify(this.#maskStretch));
      } catch {
        // per-session adjustment still applies
      }
      if (this.#adjustLabelTimer) clearTimeout(this.#adjustLabelTimer);
      this.#adjustLabelTimer = setTimeout(() => this.setState({ adjustLabel: null }), 900);
    }
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
    this.setState({ recording: true });
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
      if (this.#disposed) return;
      this.setState({ recording: false });
      void blobToBase64(blob)
        .then((base64) => this.props.onVideo({ base64, mimeType, durationSeconds }))
        .catch((error) => this.props.onCaptureError(String((error as Error).message || error)));
    };
    recorder.start();
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
          // Tap = next background/card; drag starting on an eye/lip cutout
          // = adjust that mask's looseness (see #onPointerMove).
          onPointerDown={this.#onPointerDown}
          onPointerMove={this.#onPointerMove}
          onPointerUp={this.#onPointerUp}
          onPointerCancel={this.#onPointerUp}
        />
        {this.#modesForActiveFilter().length > 1 && !this.state.recording ? (
          <button
            className="mode"
            onClick={() => {
              this.#modeIndex += 1;
              this.forceUpdate();
            }}
            type="button"
          >
            {this.#modesForActiveFilter()[this.#modeIndex % this.#modesForActiveFilter().length]}
          </button>
        ) : null}
        {this.state.filterError !== null ? (
          <div className="pill error">Filter error: {this.state.filterError}</div>
        ) : null}
        {this.state.adjustLabel !== null ? (
          <div className="pill">{this.state.adjustLabel}</div>
        ) : null}
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
  .mode {
    position: fixed;
    left: 12px;
    bottom: calc(190px + env(safe-area-inset-bottom));
    background: rgba(11, 11, 15, 0.7);
    color: #fff;
    font: 13px -apple-system, sans-serif;
    padding: 8px 14px;
    border: none;
    border-radius: 999px;
  }
`;
