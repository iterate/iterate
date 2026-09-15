import { expect, test } from "vitest";
import {
  beginImageFrame,
  cachedImage,
  imageFrameState,
  prefetchImage,
  retryFailedImages,
} from "./images.ts";

test("preloads use the image cache without delaying capture or surfacing another card's error", () => {
  using browser = imageBrowser();
  const ready = "https://mobile.iterate.com/filter-assets/preload-ready.png";
  const broken = "https://mobile.iterate.com/filter-assets/preload-broken.png";
  beginImageFrame();
  prefetchImage("ready", ready);
  prefetchImage("broken", broken);
  expect(browser.images).toHaveLength(2);
  expect(imageFrameState()).toMatchObject({ pending: [], error: null });
  browser.images[0].naturalWidth = 100;
  browser.images[0].onload();
  browser.images[1].onerror();
  expect(imageFrameState()).toMatchObject({ pending: [], error: null });

  beginImageFrame();
  expect(cachedImage("ready", ready)).toBe(browser.images[0]);
  expect(browser.images).toHaveLength(2);
  expect(imageFrameState()).toMatchObject({ pending: [], error: null });

  beginImageFrame();
  expect(cachedImage("broken", broken)).toBeNull();
  expect(imageFrameState()).toMatchObject({ pending: [], error: "Could not load image: broken" });
  retryFailedImages();
  beginImageFrame();
  expect(cachedImage("broken", broken)).toBeNull();
  expect(browser.images).toHaveLength(3);
  expect(imageFrameState().pending).toHaveLength(1);
  browser.images[2].naturalWidth = 100;
  browser.images[2].onload();
  expect(imageFrameState()).toMatchObject({ pending: [], error: null });
});

function imageBrowser() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
  const images: any[] = [];
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: class {
      naturalWidth = 0;
      constructor() {
        images.push(this);
      }
    },
  });
  return {
    images,
    [Symbol.dispose]() {
      for (const image of images) image.onerror?.();
      if (original) Object.defineProperty(globalThis, "Image", original);
      else Reflect.deleteProperty(globalThis, "Image");
    },
  };
}
