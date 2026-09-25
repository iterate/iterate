# Drawing for this device

You are speaking to someone using `itx.clients.{{DEVICE}}`. It advertises a
screen. Call `itx.cd("/").clients.{{DEVICE}}.screen.info()` before designing a
view: the result gives `width`, `height`, `formats`, `preferredFormat`,
`partialRefresh`, and `refreshTimeoutMs`. Never infer these from a board name.
Use `itx.cd("/").voice.setImage({ device: "{{DEVICE}}", image: { html } })`.
You may select a supported `image.format`: `mono1` is black/white, `gray4` is
16 shades of grey, and `rgb565` is colour. The default is the device's
preferred format. NOTE4 grayscale requires a slower full refresh. No screen
in this interface implies touch input. Show one useful static view at a time.

The device receives pixels; HTML, fonts and image conversion run on the
server. The following example is designed for a 400 × 300 screen: adapt its
layout to the actual advertised dimensions for any other screen.

## Render on the pixel grid

- Render at the advertised width × height in CSS pixels, `deviceScaleFactor: 1`. The image
  setter already selects this viewport. Use `margin: 0`, `box-sizing:
border-box` and `overflow: hidden`; keep useful content 16px from the edges.
- Use integer pixel sizes, positions, gaps and line heights. Prefer explicit
  columns to layouts that divide into fractional widths. Avoid fractional
  transforms, CSS zoom, rotated text and resizing a larger screenshot down.
- For `mono1`, use opaque `#000` and `#fff`. Separate sections with space, a solid rule,
  or an inverted black block with white text. Avoid shadows, blurs, gradients,
  translucent borders and subtle differences in grey. These are design
  recommendations for monochrome displays, not Chromium limitations.

## Text

Use the supplied **Iterate Pixel** font (Press Start 2P), normal weight 400,
usually **16px/24px** for text and **24px/32px** for headings. It produced
strictly black/white glyphs at those sizes in the actual Chromium bench test.
Avoid synthetic bold/italic. Use `font-kerning: none`,
`font-variant-ligatures: none` and `letter-spacing: 0`; shorten labels instead
of squeezing text with transforms. These settings alone do not turn an
ordinary font into a bitmap font.

The bundled font contains printable ASCII: use ordinary quotes, hyphens,
digits and short labels; draw symbols as SVG if needed. A 16px character is
approximately 16px wide, so plan for about 21 characters in a 336px content
area. Do not rely on emoji or an uninstalled system font for an icon.

Fetch `screen-font.css` from root KV and embed the returned CSS in
`<style>`. Its font is a 2.5KB WOFF2 data URL: no external font request, and no
need to print the base64 data in your reply. Browser Run supports embedded
custom fonts; otherwise an unavailable family can silently fall back.
[Cloudflare custom fonts](https://developers.cloudflare.com/browser-run/features/custom-fonts/)

Prefer static, self-contained HTML with embedded assets. Avoid animation,
framework bootstrapping and external stylesheets. If building a separate
renderer with external fonts, await `document.fonts.ready` before capture;
do not substitute an arbitrary sleep. The copyable view below embeds its font.
[Font readiness](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/ready)

## Borders, rules and icons

Use square corners and **1px or 2px solid CSS borders** on integer-positioned
boxes. A filled `height: 1px` or `height: 2px` black rectangle is a dependable
horizontal divider. Make critical dividers and small icon strokes 2px when
possible; keep detail sparse. Prefer filled pixel shapes for small icons.

For SVG, set matching integer `width`, `height` and `viewBox` dimensions so
one SVG unit is one screen pixel. Use `shape-rendering="crispEdges"` for
rectilinear charts and icons; it is a rendering hint, not a substitute for
correct geometry. Use filled `<rect>` elements for rules to avoid stroke
centering. [SVG shape rendering](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/shape-rendering)

```html
<svg
  width="336"
  height="18"
  viewBox="0 0 336 18"
  xmlns="http://www.w3.org/2000/svg"
  shape-rendering="crispEdges"
>
  <rect x="0" y="0" width="336" height="2" fill="#000" />
  <rect x="0" y="8" width="160" height="8" fill="#000" />
</svg>
```

For a canvas or SVG stroke, its width is centered on the path: align an
axis-aligned **1px stroke at a half-pixel coordinate**, or a **2px stroke at an
integer coordinate**, when rendering 1:1. Do not shift the entire page by
half a pixel; CSS filled boxes use integer edges. [Stroke alignment](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Applying_styles_and_colors)

For pixel-art raster assets, use native size or an integer scale with
`image-rendering: pixelated`. For canvas image scaling also set
`ctx.imageSmoothingEnabled = false`. These control raster-image scaling;
**they do not disable font or vector antialiasing**.
[Pixel-art scaling](https://developer.mozilla.org/en-US/docs/Games/Techniques/Crisp_pixel_art_look)
[Canvas image smoothing](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingEnabled)

In `mono1`, the server applies ordered dithering to grey pixels. `gray4`
quantizes to sixteen levels, while `rgb565` retains colour. That can help photos,
but grey antialiased text becomes a dot pattern. Prefer already-black/white
text and UI; reserve dithered imagery for larger areas. Do not depend on
`-webkit-font-smoothing: none`: it is not a portable Chromium/Linux solution.
[Font smoothing limitations](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-smooth)

## Copyable view

### Photos and other raster images

Discover image URLs from the actual source page; never guess an asset path.
Resolve relative URLs against that page. Before rendering, fetch the chosen
URL and check for a successful HTTP status and an `image/` content type.
A 404 page is not an image, even when its URL ends in `.jpg`.

Use an explicit `<img src="..." width="400" height="300"
style="object-fit:contain">`, with an HTML-escaped URL. The setter waits for
every `<img>` to decode before capture, up to five seconds. A broken or slow
image fails the call and leaves the previous screen intact. Use `<img>` for
photos, rather than CSS background images, so this check covers them.
For assets that block remote loading, fetch and embed a real image data URL
only if the whole HTML still fits the 24,000-character limit. Do not invent
base64 or truncate an image to fit. Choose a smaller source if necessary.

If rendering fails, report it or choose another verified source. A successful
transfer confirms the rendered pixels reached the panel; it does not prove
that the photo depicts the requested subject.

### Text and layout

Run this code inside your normal `<codemode>` response. Change the content
and layout, keep the font embedding and screen dimensions. Escape any
untrusted values before inserting them into HTML. The helper accepts at most
24,000 HTML characters, including the roughly 3.5KB embedded font CSS.

```ts
const root = itx.cd("/");
const fontCSS = await root.kv.get("screen-font.css");
if (!fontCSS) throw new Error("Screen font is not installed");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${fontCSS}
* { box-sizing: border-box; }
html, body { width: 400px; height: 300px; margin: 0; overflow: hidden; }
body {
  padding: 16px; background: #fff; color: #000;
  font: 400 16px/24px "Iterate Pixel", monospace;
  font-kerning: none; font-variant-ligatures: none; letter-spacing: 0;
}
main { height: 268px; border: 2px solid #000; padding: 14px; }
h1 { margin: 0; font: 400 24px/32px "Iterate Pixel", monospace; }
p { margin: 8px 0 0; }
.rule { height: 2px; margin: 12px 0; background: #000; }
.grid { display: grid; grid-template-columns: 160px 160px; gap: 16px; }
.cell { height: 80px; border: 1px solid #000; padding: 11px; }
.label { font-size: 16px; line-height: 16px; }
.value { margin-top: 8px; font-size: 24px; line-height: 32px; }
footer { margin-top: 16px; }
</style></head><body><main>
<h1>NEXT STEP</h1><p>Focus for 25 min</p><div class="rule"></div>
<div class="grid">
  <div class="cell"><div class="label">TIME</div><div class="value">25:00</div></div>
  <div class="cell"><div class="label">STEP</div><div class="value">1 / 3</div></div>
</div>
<footer>KEY: start/stop</footer>
</main></body></html>`;

return await root.voice.setImage({
  device: "{{DEVICE}}",
  image: { html },
});
```

To restore the normal status screen, use **the same setter**:

```ts
return await itx.cd("/").voice.setImage({
  device: "{{DEVICE}}",
  image: null,
});
```

Say the image was shown only after the setter returns `shown: true`. It
returns once the device has finished its refresh.
This acknowledges the controller operation, not an optical measurement. A failure must
be reported rather than described as success.

For previews, `itx.browser.quickAction("screenshot", { html,
viewport: { width: 400, height: 300, deviceScaleFactor: 1 },
screenshotOptions: { type: "png", fullPage: false } })` returns PNG bytes.
Inspect the final 1-bit result as well as the browser screenshot when checking
new layouts. [Cloudflare screenshots](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/)
