type ImageLoad = {
  image: HTMLImageElement;
  pending: Promise<void> | null;
  error: string | null;
};

// One DOM camera per WebView. Keep decoded images across frames, but report
// only images used by the current frame (not another card/filter's failure).
const images = new Map<string, ImageLoad>();
const frameImages = new Set<ImageLoad>();

export function beginImageFrame() {
  frameImages.clear();
}

export function imageFrameState() {
  return {
    pending: [...frameImages].flatMap((entry) => (entry.pending ? [entry.pending] : [])),
    error: [...frameImages].find((entry) => entry.error)?.error || null,
  };
}

export function retryFailedImages() {
  for (const [url, entry] of images) if (entry.error) images.delete(url);
}

/** Project-filter API: returns null until ready; accepts data URIs too.
 * URL is part of identity so edits to project art cannot reuse stale pixels. */
export function cachedImage(key: string, url: string | undefined): HTMLImageElement | null {
  const entry = loadImage(key, url);
  if (!entry) return null;
  frameImages.add(entry);
  return entry.pending || entry.error ? null : entry.image;
}

/** Warm the same cache without delaying capture of the current card. */
export function prefetchImage(key: string, url: string | undefined) {
  loadImage(key, url);
}

function loadImage(key: string, url: string | undefined) {
  if (!url) return null;
  const cacheKey = `${key}:${url}`;
  let entry = images.get(cacheKey);
  if (!entry) {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const load: ImageLoad = { image, pending: null, error: null };
    load.pending = new Promise<void>((resolve) => {
      const finish = (error: string | null) => {
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        load.pending = null;
        load.error = error;
        if (error) image.src = "";
        resolve();
      };
      const timer = setTimeout(() => finish(`Image timed out: ${key}`), 30_000);
      image.onload = () => finish(image.naturalWidth ? null : `Empty image: ${key}`);
      image.onerror = () => finish(`Could not load image: ${key}`);
      image.src = url;
    });
    images.set(cacheKey, load);
    entry = load;
  }
  return entry;
}
