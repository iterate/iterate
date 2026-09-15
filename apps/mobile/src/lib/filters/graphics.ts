import { cachedImage as loadImage } from "./images.ts";

/** The drawing contract shared by the browser and native filter engines.
 * source is an opaque image handle, owned by the corresponding renderer. */
export type FilterImage = { width: number; height: number; source: unknown };
export type FilterContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "clearRect"
  | "fillRect"
  | "strokeRect"
  | "translate"
  | "rotate"
  | "scale"
  | "setTransform"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "arc"
  | "ellipse"
  | "roundRect"
  | "fill"
  | "stroke"
  | "clip"
  | "fillText"
  | "fillStyle"
  | "strokeStyle"
  | "globalAlpha"
  | "globalCompositeOperation"
  | "lineWidth"
  | "font"
  | "textAlign"
  | "textBaseline"
  | "imageSmoothingEnabled"
> & { drawImage(image: FilterImage, ...coordinates: number[]): void };
export type FilterCanvas = FilterImage & { getContext(kind: "2d"): FilterContext };

export function browserImage(source: HTMLCanvasElement | HTMLImageElement): FilterImage {
  return { source, width: source.width, height: source.height };
}

export function browserContext(context: CanvasRenderingContext2D): FilterContext {
  // Proxy replaces drawImage with the shared opaque-image signature.
  return new Proxy(context, {
    get(target, key) {
      if (key === "drawImage")
        return (image: FilterImage, ...coordinates: number[]) => {
          // Browser image handles are created only by browserImage/createFilterCanvas.
          const source = image.source as CanvasImageSource;
          if (coordinates.length === 2) target.drawImage(source, coordinates[0], coordinates[1]);
          else if (coordinates.length === 4)
            target.drawImage(
              source,
              coordinates[0],
              coordinates[1],
              coordinates[2],
              coordinates[3],
            );
          else if (coordinates.length === 8)
            target.drawImage(
              source,
              coordinates[0],
              coordinates[1],
              coordinates[2],
              coordinates[3],
              coordinates[4],
              coordinates[5],
              coordinates[6],
              coordinates[7],
            );
          else throw new Error("drawImage needs 2, 4, or 8 coordinates");
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, key, value) {
      return Reflect.set(target, key, value, target);
    },
  }) as unknown as FilterContext;
}

export function createFilterCanvas(): FilterCanvas {
  const source = document.createElement("canvas");
  const context = browserContext(source.getContext("2d")!);
  return {
    source,
    get width() {
      return source.width;
    },
    set width(value) {
      source.width = value;
    },
    get height() {
      return source.height;
    },
    set height(value) {
      source.height = value;
    },
    getContext: () => context,
  };
}

export function cachedImage(key: string, url: string | undefined): FilterImage | null {
  const image = loadImage(key, url);
  return image ? browserImage(image) : null;
}

let toneContext: AudioContext | null = null;
export function playTone(hz: number, durationMs: number) {
  toneContext = toneContext || new AudioContext();
  void toneContext.resume();
  const oscillator = toneContext.createOscillator();
  const gain = toneContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = hz;
  const now = toneContext.currentTime;
  const seconds = durationMs / 1000;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.4, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
  oscillator.connect(gain).connect(toneContext.destination);
  oscillator.start(now);
  oscillator.stop(now + seconds + 0.05);
}
