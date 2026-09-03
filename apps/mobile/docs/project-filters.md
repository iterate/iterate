# Project camera filters

The mobile app's camera (✨ button) loads filters from the project's repos:
any file matching `filters/<name>.filter.js` appears in the picker. Write
one — or ask iterate to — and reopen the camera.

**For agents**: copy this whole document into the project repo (for example
as `filters/README.md`) so "add a paper toss filter" prompts have the
contract in front of them. Nothing here requires the iterate monorepo.

## File contract

The file is ONE JavaScript object expression (not a module, no imports):

```js
({
  label: "Carrot",
  emoji: "🥕",
  // optional: the camera shows a cycle button for these; read args.modeIndex
  modes: ["Meadow", "Space"],
  draw(args) {
    // called ~60×/second; draw the whole frame every call
    args.ctx.fillStyle = "#7cb342";
    args.ctx.fillRect(0, 0, args.width, args.height);
    args.helpers.emoji(
      "🥕",
      args.face.box.cx,
      args.face.box.cy,
      args.face.box.width * 2,
      args.face.box.angle,
    );
    args.helpers.featureCutout("eyes", args.face.leftEye);
    args.helpers.featureCutout("eyes", args.face.rightEye);
    args.helpers.featureCutout("lips", args.face.lips);
  },
});
```

It runs inside the camera's WebView with the same trust as the rest of the
project's userland code. A filter that throws shows an error pill over the
plain camera; fix the file and reopen.

## args — what draw() receives

| field             | what it is                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx`             | Canvas 2D context, full-screen, device pixels                                                                                                                                                                                                                                                                                                                                |
| `frame`           | the current camera frame (already mirrored for the front camera); `ctx.drawImage(frame, 0, 0)` paints the plain preview                                                                                                                                                                                                                                                      |
| `width`, `height` | canvas size in device pixels                                                                                                                                                                                                                                                                                                                                                 |
| `face`            | tracked geometry: `box` (`cx, cy, width, height, angle` — angle is head roll in radians) and features `leftEye`, `rightEye`, `nose`, `lips`. Each feature has `ring` (polygon points), `center`, `rx`/`ry` (half-extents), `angle`. `leftEye` is always the CANVAS-left eye. `face.tracked` is false when tracking has no face (a guessed face is supplied so keep drawing). |
| `facePose`        | head movement vs where the face was when the filter started: `dx`, `dy` (canvas px), `scale` (>1 = leaning in)                                                                                                                                                                                                                                                               |
| `pitchHz`         | fundamental of whatever the mic hears, or null in silence                                                                                                                                                                                                                                                                                                                    |
| `backgroundIndex` | increments on every plain tap — cycle scenes with `backgroundIndex % n`                                                                                                                                                                                                                                                                                                      |
| `modeIndex`       | increments when the mode button is tapped (only shown if you declare `modes`)                                                                                                                                                                                                                                                                                                |
| `modeIndex2`      | second mode group's counter (built-in filters only for now)                                                                                                                                                                                                                                                                                                                  |
| `action`          | last settings-row action press `{id, seq}` — declare buttons via `actions: [{id, label}]` on your filter                                                                                                                                                                                                                                                                     |
| `tap`             | most recent tap: `{x, y, seq}` — remember `seq` to react once per tap                                                                                                                                                                                                                                                                                                        |
| `drag`            | a drag the pipeline did not consume (see adjust modes below): `{startX, startY, dx, dy, active, seq}` — snapshot state when `seq` changes                                                                                                                                                                                                                                    |
| `adjust`          | the user's global scale tuning: `{featureScale, faceScale}`. The cutout helper applies both to in-place masks and `featureScale` to remapped ones; if your filter lays a face out itself, multiply your layout by `faceScale`                                                                                                                                                |
| `maskStretch`     | the user's cutout-looseness tuning; featureCutout applies it for you                                                                                                                                                                                                                                                                                                         |
| `timeMs`          | monotonic clock for animation                                                                                                                                                                                                                                                                                                                                                |

The camera's adjust button cycles what drags do: **holes** (drag on a
feature reshapes its mask; other drags reach `args.drag`), **features**
(any drag scales all cutouts in place), **face** (any drag scales the whole
face). In the two scale modes drags never reach `args.drag`.

Useful derived signals: blink = `face.leftEye.ry / face.leftEye.rx` drops
below ~0.16 (use hysteresis: reopen above ~0.22); mouth open =
`face.lips.ry / face.lips.rx` above ~0.7.

## args.helpers — the toolkit

| helper                                   | what it does                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `featureCutout(kind, feature, dest?)`    | sample the live video under a feature (mask shaped like its landmark ring, feathered) and paint it. No `dest` = in place. With `dest: {cx, cy, width, angle, softness?, alpha?}` = remapped, uniformly scaled (never squashes). `kind` is `"eyes"`, `"nose"`, or `"lips"` (picks base looseness + the user's tuning). |
| `naturalWidth(kind, feature)`            | the `dest.width` that renders a feature at 1:1 size                                                                                                                                                                                                                                                                   |
| `ellipseFeature(cx, cy, rx, ry, angle?)` | an invented elliptical feature — sample skin patches or arbitrary screen regions                                                                                                                                                                                                                                      |
| `emoji(glyph, cx, cy, sizePx, angle)`    | draw an emoji centered at a point                                                                                                                                                                                                                                                                                     |
| `cachedImage(key, dataUri)`              | decode-once image cache; returns null while decoding — inline art as data URIs                                                                                                                                                                                                                                        |
| `imageCover(image)`                      | cover-fit an image over the whole canvas                                                                                                                                                                                                                                                                              |
| `playTone(hz, durationMs)`               | beep a sine tone                                                                                                                                                                                                                                                                                                      |

## Patterns from the built-in filters

- **Mask stuck to a character** (potato): draw the character at a fixed
  spot moved by `facePose`, then `featureCutout` each feature to
  character-relative positions rotated by `face.box.angle`.
- **Game state**: keep it in a variable above the object expression? No —
  the file is one expression, so close over state inside `draw` via
  properties on the definition object itself (`this.state ||= {...}` inside
  `draw` works: `draw` is a method).
- **Reset on tap**: compare `args.tap?.seq` with a remembered value.
- **Per-frame cost**: stay with drawImage/fills/cutouts; avoid
  `getImageData` per frame — it will drop the frame rate.
