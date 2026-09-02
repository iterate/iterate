// All the camera-filter asset generation in one trpc-cli module CLI —
// scene backdrops, the two flashcard decks, the animal mask portraits, and
// the vision anchor pass. Each command is merge-mode: existing committed
// art is kept and only missing entries generate, so approved art survives
// word-list growth. Manual, not CI — needs API keys and is
// non-deterministic:
//
//   cd apps/os && doppler run -- sh -c 'cd ../mobile && pnpm generate-filters <command>'
//
//   pnpm generate-filters backdrops
//   pnpm generate-filters flashcards --style encyclopaedia
//   pnpm generate-filters animals
//   pnpm generate-filters animal-anchors
//
// cartoon/encyclopaedia/backdrops/animals use OPENAI_API_KEY (gpt-image-1);
// flashcards --style photo pulls real photographs from Unsplash and needs
// UNSPLASH_ACCESS_KEY (a free demo key covers the word list).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILTERS_DIR = new URL("../src/lib/filters/", import.meta.url).pathname;

/** Regenerate the scene backdrop images (backdrops.generated.ts). */
export async function backdrops() {
  const style =
    "Funny, simple, colorful cartoon illustration, flat shading, portrait orientation, no text, no letters, no people, no faces.";
  const prompts: Record<string, string> = {
    "potato-dirt": `${style} Underground cross-section of garden soil filling the whole frame: a thin strip of bright green grass and blue sky across the very top, rich brown dirt with pebbles and two cute cartoon worms below. The center of the dirt is plain and uncluttered.`,
    "potato-farm": `${style} Underground cross-section of farm soil: thin strip of golden wheat field and a red barn across the very top, warm brown dirt with a few buried carrots at the edges below. The center of the dirt is plain and uncluttered.`,
    "potato-rain": `${style} Underground cross-section of soil on a rainy day: thin strip of grey sky, rain and puddles across the very top, dark wet dirt with a buried snail at one edge below. The center of the dirt is plain and uncluttered.`,
    "eyes-lips-beach": `${style} Tropical beach seen from the sand: turquoise sea, small island with a palm tree, big sun, a crab on the sand. The middle of the sky is plain and uncluttered.`,
    "eyes-lips-space": `${style} Outer space: deep blue-purple starfield, a ringed planet, a crescent moon, a tiny rocket. The center is plain and uncluttered.`,
    "eyes-lips-sunset": `${style} City rooftop at sunset: orange-pink gradient sky, dark building silhouettes along the bottom, a few bats. The middle of the sky is plain and uncluttered.`,
    "cat-study": `${style} A lawyer's home office for a video call: warm wood bookshelves full of law books, a desk lamp, framed diploma. The center is plain and uncluttered.`,
    "cat-garden": `${style} Sunny garden: green lawn, flowers, a butterfly, a watering can. The center is plain and uncluttered.`,
    "cat-livingroom": `${style} Cozy living room: sofa, houseplant, ball of yarn on the rug, warm lamp light. The center is plain and uncluttered.`,
  };
  return generateImageRecord({
    file: "backdrops.generated.ts",
    exportName: "FILTER_BACKDROPS",
    mime: "jpeg",
    header: "AI-generated backdrop images for the camera filters.",
    entries: Object.keys(prompts),
    generate: (id) =>
      openaiImage(prompts[id], { size: "1024x1536", quality: "low", format: "jpeg", shrink: 672 }),
  });
}

// Pictures an 18-month-old might know the word for. Keep in sync with the
// FLASHCARDS list in lib/filters/definitions.ts (color-swatch cards are
// drawn, not generated).
const FLASHCARD_WORDS = [
  "dog",
  "cat",
  "ball",
  "banana",
  "apple",
  "water",
  "milk",
  "tomato",
  "cucumber",
  "door",
  "chair",
  "bed",
  "cow",
  "pig",
  "horse",
  "sheep",
  "duck",
  "chicken",
  "carrot",
  "pasta",
  "bread",
  "cheese",
  "egg",
  "strawberry",
  "grapes",
  "orange",
  "car",
  "bus",
  "train",
  "book",
  "star",
  "moon",
  "sun",
  "tree",
  "flower",
  "fish",
  "bird",
  "shoe",
  "hat",
  "spoon",
  "nose",
  "ear",
  "hand",
  "foot",
  "sock",
  "cup",
  "bowl",
  "plate",
  "bottle",
  "phone",
  "keys",
  "bath",
  "brush",
  "cookie",
  "cake",
  "juice",
  "corn",
  "peas",
  "bear",
  "lion",
  "elephant",
  "monkey",
  "rabbit",
  "frog",
  "bee",
  "mouse",
  "butterfly",
  "snail",
  "worm",
  "bike",
  "boat",
  "plane",
  "truck",
  "tractor",
  "balloon",
  "teddy bear",
  "doll",
  "blocks",
  "cloud",
  "snow",
  "honey",
  "toast",
  "peanut butter",
  "broccoli",
  "ice lolly",
  "ice cream",
  "pear",
  "kiwi",
  "eye",
  "chin",
  "penguin",
  "giraffe",
  "piano",
  "taxi",
  "scooter",
  "digger",
  "fire engine",
  "motorbike",
];

const FLASHCARD_NOUNS: Record<string, string> = {
  water: "a glass of water",
  milk: "a glass of milk",
  keys: "a set of house keys",
  peas: "a bowl of green peas",
  corn: "a corn on the cob",
  juice: "a cup of orange juice",
  snow: "snow falling on a snowy field",
  blocks: "a stack of colorful toy building blocks",
  bath: "a bathtub with bubbles",
  brush: "a hairbrush",
  nose: "an extreme close-up of a nose only, cropped so tightly that no eyes and no mouth are visible",
  ear: "an ear",
  hand: "an open hand",
  foot: "a bare foot",
  door: "an open door, seen from the front, opening into a bright room",
  book: "an open children's picture book lying flat, colorful pages visible",
  pasta: "a bowl of cooked pasta",
  bus: "a red London double-decker bus",
  honey: "a jar of golden honey with a wooden honey dipper",
  toast: "a slice of buttered toast",
  "peanut butter": "an open jar of peanut butter with a spoon",
  broccoli: "a head of broccoli",
  "ice lolly": "a fruit ice lolly on a wooden stick",
  "ice cream": "an ice cream cone with a scoop of vanilla",
  eye: "a single friendly open human eye",
  chin: "an extreme close-up of a chin and jawline only, cropped just below the lower lip, no eyes or nose visible",
  taxi: "a black London taxi cab",
  scooter: "a child's kick scooter",
  digger: "a yellow digger excavator",
  "fire engine": "a red British fire engine",
  motorbike: "a motorbike on its stand",
  doll: "a soft rag doll toy with yarn hair and stitched button eyes, obviously a stuffed toy, propped sitting",
};

const noun = (word: string) => FLASHCARD_NOUNS[word] || `a ${word}`;

/** Regenerate one flashcard style (flashcards-<style>.generated.ts). */
export async function flashcards(options: {
  /** which picture style: cartoon | encyclopaedia | photo (photo = Unsplash, needs UNSPLASH_ACCESS_KEY) */
  style: "cartoon" | "encyclopaedia" | "photo";
}) {
  const { style } = options;
  const generate = async (word: string) => {
    if (style === "photo") return unsplashImage(word);
    if (style === "cartoon") {
      return openaiImage(
        `Cute, simple, friendly cartoon illustration of ${noun(word)} for a toddler flashcard. Single object centered, bold outlines, flat bright colors, plain solid very light background, no text, no letters, no people unless the word is baby.`,
        { size: "1024x1024", quality: "low", format: "jpeg", shrink: 448 },
      );
    }
    return openaiImage(
      `A realistic photograph of ${noun(word)} for a children's picture encyclopedia. Single subject centered and filling most of the frame, plain softly-lit studio background, natural colors and real textures with fine detail, slight natural imperfections, shot on a DSLR. Absolutely not a drawing, painting, or illustration; no airbrushed or artificial look; no text.`,
      { size: "1024x1024", quality: "medium", format: "jpeg", shrink: 448 },
    );
  };
  return generateImageRecord({
    file: `flashcards-${style}.generated.ts`,
    exportName: `FLASHCARD_IMAGES_${style.toUpperCase()}`,
    mime: "jpeg",
    header: `Toddler flashcard pictures, ${style} style.`,
    entries: FLASHCARD_WORDS,
    generate,
  });
}

// "Friendly" is species-specific: primates read bared teeth as threat, cats
// read slow-blink as warmth, big cats read big pupils + forward ears as
// unthreatening. Each animal gets its own cues instead of one adjective.
const ANIMAL_EXPRESSIONS: Record<string, string> = {
  cat: "a relaxed half-lidded slow-blink expression, softly rounded eyes with large pupils, whiskers and ears relaxed and forward",
  dog: "a gentle soft-browed expression, calm warm eyes, ears relaxed",
  goat: "a placid calm expression, soft eyes, ears relaxed outward",
  tiger:
    "a calm unthreatening expression, soft eyes with large round pupils, relaxed brow and whiskers, ears forward",
  bear: "a calm teddy-bear softness, gentle small eyes, relaxed muzzle",
  monkey: "a calm curious expression, softly raised brows, relaxed jaw, absolutely no bared teeth",
  gorilla:
    "a serene thoughtful expression, soft unfurrowed brow, gentle curious eyes, relaxed jaw, absolutely no bared teeth",
  lion: "a calm gentle expression, soft warm eyes, relaxed brow, a fluffy mane",
  horse:
    "a gentle soft-eyed expression, ears relaxed and pointed forward, calm nostrils — zoomed out so the whole head is small and centered with generous empty space on every side, the muzzle, mouth and chin entirely visible well above the bottom edge",
  fox: "a bright curious friendly expression, soft eyes, relaxed whiskers",
  mouse: "a sweet curious expression, bright soft eyes, relaxed whiskers",
};

/** Regenerate the Animal mask portraits (animal-faces.generated.ts). After
 * regenerating, re-run animal-anchors and verify with the harness
 * ?annotate=1 view — anchors are per-image. */
export async function animals() {
  return generateImageRecord({
    file: "animal-faces.generated.ts",
    exportName: "ANIMAL_FACE_IMAGES",
    mime: "png",
    header:
      "Photorealistic transparent-background animal face portraits for the Animal mask filter.",
    entries: Object.keys(ANIMAL_EXPRESSIONS),
    generate: (animal) =>
      openaiImage(
        `A photorealistic portrait of a ${animal}'s face looking directly at the camera, perfectly head-on and symmetrical, both eyes clearly visible and level, mouth closed, with ${ANIMAL_EXPRESSIONS[animal]} — warm soft lighting, kind and approachable, while staying a realistic photograph (not a cartoon or illustration). The head fills most of the frame, on a fully transparent background. Only the head — no body, no text.`,
        { size: "1024x1024", quality: "medium", format: "png", transparent: true, shrink: 448 },
      ),
  });
}

/** Vision-model pass over the animal portraits, writing eye/mouth landmark
 * guesses to animal-anchors.generated.ts. Known-mediocre (it leans on
 * priors) — treat as a base and verify/correct via the harness ?annotate=1
 * view + ANIMAL_ANCHOR_OVERRIDES in definitions.ts. */
export async function animalAnchors() {
  const source = readFileSync(join(FILTERS_DIR, "animal-faces.generated.ts"), "utf8");
  const images = [...source.matchAll(dataUriEntryPattern("png"))].map((match) => ({
    id: match[1] || match[2],
    dataUri: `data:image/png;base64,${match[3]}`,
  }));
  if (images.length === 0) throw new Error("No animal images found — run `animals` first");
  const results: [string, unknown][] = [];
  for (const { id, dataUri } of images) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `This is a square photo of a ${id}'s face looking at the camera. Find these landmarks precisely and answer with STRICT JSON only:
{"leftEye": {"x": .., "y": ..}, "rightEye": {"x": .., "y": ..}, "mouth": {"x": .., "y": ..}, "eyeWidth": .., "mouthWidth": ..}
All values are FRACTIONS of the image size between 0 and 1 (x from left edge, y from top edge).
- leftEye / rightEye: the CENTER of each eyeball (viewer's left = leftEye). Look carefully at where the actual eyes are, not where they usually are on such an animal.
- mouth: the point where the lips part (the mouth opening), NOT the nose.
- eyeWidth: one eye's width as a fraction of image width, with ~30% margin.
- mouthWidth: the mouth's width as a fraction of image width.`,
              },
              { type: "image_url", image_url: { url: dataUri, detail: "high" } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`${id}: ${response.status} ${await response.text()}`);
    const payload = (await response.json()) as { choices: { message: { content: string } }[] };
    const anchors = JSON.parse(payload.choices[0].message.content) as unknown;
    console.log(id, JSON.stringify(anchors));
    if (anchors) results.push([id, anchors]);
  }
  const outPath = join(FILTERS_DIR, "animal-anchors.generated.ts");
  writeFileSync(
    outPath,
    `${generatedHeader("Vision-model-detected eye/mouth landmarks for the Animal mask portraits (hand overrides go in definitions.ts); regenerate whenever the art regenerates.")}
export type AnimalAnchors = {
  leftEye: { x: number; y: number };
  rightEye: { x: number; y: number };
  mouth: { x: number; y: number };
  eyeWidth: number;
  mouthWidth: number;
};

export const ANIMAL_ANCHORS: Record<string, AnimalAnchors> = ${JSON.stringify(Object.fromEntries(results), null, 2)};
`,
  );
  return { wrote: outPath, detected: results.length };
}

// ---------------------------------------------------------------------------
// Shared plumbing

function apiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set (run through doppler)");
  return key;
}

const scratchDir = () => mkdtempSync(join(tmpdir(), "generate-filters-"));

function generatedHeader(what: string) {
  return `// Generated by scripts/generate-filters.ts — do not edit by hand.
// ${what} Inlined as data URIs. ONLY import via lib/filters — generated
// image data must not ride into the native Hermes bundle.

`;
}

function dataUriEntryPattern(mime: string) {
  // Tolerates formatter drift: quoted or bare keys, same-line or wrapped.
  return new RegExp(
    `(?:"([^"]+)"|([A-Za-z]\\w*)):\\s*\\n?\\s*"data:image/${mime};base64,([^"]+)"`,
    "g",
  );
}

async function openaiImage(
  prompt: string,
  options: {
    size: "1024x1024" | "1024x1536";
    quality: "low" | "medium";
    format: "jpeg" | "png";
    transparent?: boolean;
    shrink: number;
  },
) {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      size: options.size,
      quality: options.quality,
      output_format: options.format,
      ...(options.transparent && { background: "transparent" }),
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const payload = (await response.json()) as { data: { b64_json: string }[] };
  const raw = join(scratchDir(), `image.${options.format}`);
  writeFileSync(raw, Buffer.from(payload.data[0].b64_json, "base64"));
  const sipsArgs = ["-Z", String(options.shrink)];
  if (options.format === "jpeg") sipsArgs.push("-s", "format", "jpeg", "-s", "formatOptions", "62");
  execFileSync("sips", [...sipsArgs, raw, "--out", raw]);
  return readFileSync(raw).toString("base64");
}

async function unsplashImage(query: string) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) throw new Error("UNSPLASH_ACCESS_KEY is not set");
  const search = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=squarish&per_page=1`,
    { headers: { Authorization: `Client-ID ${accessKey}` } },
  );
  if (!search.ok) throw new Error(`${query}: ${search.status} ${await search.text()}`);
  const result = (await search.json()).results[0];
  if (!result) throw new Error(`${query}: no Unsplash results`);
  const image = await fetch(`${result.urls.raw}&w=448&h=448&fit=crop&fm=jpg&q=70`);
  console.log(`  ${query}: photo by ${result.user?.name} (unsplash.com/@${result.user?.username})`);
  const raw = join(scratchDir(), "image.jpg");
  writeFileSync(raw, Buffer.from(await image.arrayBuffer()));
  return readFileSync(raw).toString("base64");
}

/** Merge-mode generation of one `Record<string, dataUri>` module: existing
 * entries are kept verbatim (approved, nondeterministic art), missing ones
 * generate a few at a time. */
async function generateImageRecord(input: {
  file: string;
  exportName: string;
  mime: "jpeg" | "png";
  header: string;
  entries: string[];
  generate: (id: string) => Promise<string>;
}) {
  const outPath = join(FILTERS_DIR, input.file);
  const existing = new Map<string, string>();
  try {
    for (const match of readFileSync(outPath, "utf8").matchAll(dataUriEntryPattern(input.mime))) {
      existing.set(match[1] || match[2], match[3]);
    }
  } catch {
    // no existing file — generate everything
  }
  console.log(`${existing.size} existing entries kept`);
  const results: [string, string][] = [];
  const missing = input.entries.filter((id) => !existing.has(id));
  for (let i = 0; i < missing.length; i += 4) {
    // Modest parallelism to stay clear of rate limits.
    const batch = await Promise.all(
      missing.slice(i, i + 4).map(async (id) => {
        const base64 = await input.generate(id);
        console.log(`${id}: ${Math.round((base64.length * 3) / 4 / 1024)}KB`);
        return [id, base64] as [string, string];
      }),
    );
    results.push(...batch);
  }
  const merged = new Map([...existing, ...results]);
  const body = input.entries
    .filter((id) => merged.has(id))
    .map(
      (id) => `  ${JSON.stringify(id)}:\n    "data:image/${input.mime};base64,${merged.get(id)}",`,
    )
    .join("\n");
  writeFileSync(
    outPath,
    `${generatedHeader(input.header)}export const ${input.exportName}: Record<string, string> = {
${body}
};
`,
  );
  return { wrote: outPath, kept: existing.size, generated: results.length };
}
