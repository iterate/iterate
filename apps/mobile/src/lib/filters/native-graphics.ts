import type { FilterCanvas, FilterContext, FilterImage } from "./graphics.ts";

declare const drawing: {
  createCanvas(): number;
  resize(id: number, width: number, height: number): void;
  draw(id: number, operation: string, args: unknown[]): void;
  image(key: string, url: string): FilterImage | null;
  prefetch(key: string, url: string): void;
  playTone(hz: number, durationMs: number): void;
};

const properties = {
  fillStyle: "#000",
  strokeStyle: "#000",
  globalAlpha: 1,
  globalCompositeOperation: "source-over",
  lineWidth: 1,
  font: "10px sans-serif",
  textAlign: "start",
  textBaseline: "alphabetic",
  imageSmoothingEnabled: true,
};
const methods = new Set([
  "clearRect",
  "fillRect",
  "strokeRect",
  "translate",
  "rotate",
  "scale",
  "setTransform",
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "arc",
  "ellipse",
  "roundRect",
  "fill",
  "stroke",
  "clip",
  "fillText",
]);

export function nativeContext(id: number): FilterContext {
  let state = { ...properties };
  const stack: (typeof state)[] = [];
  // The native renderer implements exactly FilterContext's declared operations.
  // Proxy supplies the properties/methods, which TypeScript cannot infer.
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (key in state) return Reflect.get(state, key);
        if (key === "save")
          return () => {
            stack.push({ ...state });
            drawing.draw(id, key, []);
          };
        if (key === "restore")
          return () => {
            state = stack.pop() || state;
            drawing.draw(id, key, []);
          };
        if (key === "drawImage")
          return (image: FilterImage, ...coordinates: number[]) =>
            drawing.draw(id, key, [image.source, ...coordinates]);
        if (methods.has(key)) return (...args: unknown[]) => drawing.draw(id, key, args);
        throw new Error(`Unsupported native drawing operation: ${key}`);
      },
      set(_target, key, value) {
        if (typeof key !== "string" || !(key in properties))
          throw new Error(`Unsupported native drawing property: ${String(key)}`);
        Reflect.set(state, key, value);
        drawing.draw(id, key, [value]);
        return true;
      },
    },
  ) as FilterContext;
}

export function createFilterCanvas(): FilterCanvas {
  const source = drawing.createCanvas();
  let width = 1,
    height = 1;
  let context = nativeContext(source);
  drawing.resize(source, width, height);
  return {
    source,
    get width() {
      return width;
    },
    set width(value) {
      width = value;
      drawing.resize(source, width, height);
      context = nativeContext(source);
    },
    get height() {
      return height;
    },
    set height(value) {
      height = value;
      drawing.resize(source, width, height);
      context = nativeContext(source);
    },
    getContext: () => context,
  };
}

export function cachedImage(key: string, url: string | undefined): FilterImage | null {
  return url ? drawing.image(key, url) : null;
}
export function prefetchImage(key: string, url: string | undefined) {
  if (url) drawing.prefetch(key, url);
}
export function playTone(hz: number, durationMs: number) {
  drawing.playTone(hz, durationMs);
}
