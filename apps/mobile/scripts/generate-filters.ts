// Manual trpc-cli commands; Doppler os/prd supplies Cloudflare and generation keys.
// Already uploaded assets are no-ops, even without a local copy or an AI key.
// pnpm generate-filters all
// pnpm generate-filters all --slug cartoon-dog --force
// pnpm generate-filters flashcards --style photo
// See ../docs/filter-assets.md. Never run generation during deployment.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { mobileWebsiteEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { AnimalAnchors, createAssetStore, syncAssetManifest } from "./filter-asset-store.ts";

type Options = {
  /** Only this full slug, e.g. cartoon-dog or animal-cat. */
  slug?: string;
  /** Generate new art even when the current object is already uploaded. */
  force?: boolean;
};
const FILTERS_DIR = new URL("../src/lib/filters/", import.meta.url).pathname;

/** Ensure the scene backdrop images are uploaded. */
export async function backdrops(options: Options = {}) {
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
  return generateImageRecord(options, {
    file: "backdrops.generated.json",
    assetPrefix: "backdrop",
    mime: "jpeg",
    entries: Object.keys(prompts),
    generate: (id, secrets) =>
      openaiImage(
        prompts[id],
        { size: "1024x1536", quality: "low", format: "jpeg", shrink: 672 },
        secrets.OPENAI_API_KEY,
      ).then((bytes) => ({ bytes })),
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

/** Ensure one flashcard style is uploaded. */
export async function flashcards(
  options: Options & {
    /** which picture style: cartoon | encyclopaedia | photo (photo = Unsplash, needs UNSPLASH_ACCESS_KEY) */
    style: "cartoon" | "encyclopaedia" | "photo";
  },
) {
  const { style } = options;
  const generate = async (word: string, secrets: Record<string, string>) => {
    if (style === "photo")
      return unsplashImage(word, secrets.UNSPLASH_ACCESS_KEY).then((bytes) => ({ bytes }));
    if (style === "cartoon") {
      return openaiImage(
        `Cute, simple, friendly cartoon illustration of ${noun(word)} for a toddler flashcard. Single object centered, bold outlines, flat bright colors, plain solid very light background, no text, no letters, no people unless the word is baby.`,
        { size: "1024x1024", quality: "low", format: "jpeg", shrink: 448 },
        secrets.OPENAI_API_KEY,
      ).then((bytes) => ({ bytes }));
    }
    return openaiImage(
      `A realistic photograph of ${noun(word)} for a children's picture encyclopedia. Single subject centered and filling most of the frame, plain softly-lit studio background, natural colors and real textures with fine detail, slight natural imperfections, shot on a DSLR. Absolutely not a drawing, painting, or illustration; no airbrushed or artificial look; no text.`,
      { size: "1024x1024", quality: "medium", format: "jpeg", shrink: 448 },
      secrets.OPENAI_API_KEY,
    ).then((bytes) => ({ bytes }));
  };
  return generateImageRecord(options, {
    file: `flashcards-${style}.generated.json`,
    assetPrefix: style,
    mime: "jpeg",
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

/** Ensure animal portraits and their coordinates are uploaded. Verify new art
 * with the harness ?annotate=1 view; vision-model coordinates may need correction. */
export async function animals(options: Options = {}) {
  return generateImageRecord(options, {
    file: "animal-faces.generated.json",
    assetPrefix: "animal",
    mime: "png",
    entries: Object.keys(ANIMAL_EXPRESSIONS),
    generate: async (animal, secrets) => {
      const bytes = await openaiImage(
        `A photorealistic portrait of a ${animal}'s face looking directly at the camera, perfectly head-on and symmetrical, both eyes clearly visible and level, mouth closed, with ${ANIMAL_EXPRESSIONS[animal]} — warm soft lighting, kind and approachable, while staying a realistic photograph (not a cartoon or illustration). The head fills most of the frame, on a fully transparent background. Only the head — no body, no text.`,
        { size: "1024x1024", quality: "medium", format: "png", transparent: true, shrink: 448 },
        secrets.OPENAI_API_KEY,
      );
      return { bytes, anchors: await detectAnimalAnchors(animal, bytes, secrets.OPENAI_API_KEY) };
    },
  });
}

/** Coordinates belong to the generated image; save them in the same manifest entry. */
async function detectAnimalAnchors(id: string, bytes: Buffer, key: string) {
  const dataUri = `data:image/png;base64,${bytes.toString("base64")}`;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
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
  const payload = z
    .object({
      choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).nonempty(),
    })
    .parse(await response.json());
  return AnimalAnchors.parse(JSON.parse(payload.choices[0].message.content));
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
  key: string,
) {
  if (!key) throw new Error("OPENAI_API_KEY is required for missing or forced images");
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    signal: AbortSignal.timeout(180_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
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
  const payload = z
    .object({ data: z.array(z.object({ b64_json: z.base64().min(1) })).nonempty() })
    .parse(await response.json());
  const directory = mkdtempSync(join(tmpdir(), "generate-filters-"));
  const raw = join(directory, `image.${options.format}`);
  try {
    writeFileSync(raw, Buffer.from(payload.data[0].b64_json, "base64"));
    const sipsArgs = ["-Z", String(options.shrink)];
    if (options.format === "jpeg")
      sipsArgs.push("-s", "format", "jpeg", "-s", "formatOptions", "62");
    execFileSync("sips", [...sipsArgs, raw, "--out", raw]);
    return readFileSync(raw);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function unsplashImage(query: string, accessKey: string) {
  if (!accessKey) throw new Error("UNSPLASH_ACCESS_KEY is not set");
  const search = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=squarish&per_page=1`,
    { headers: { Authorization: `Client-ID ${accessKey}` }, signal: AbortSignal.timeout(30_000) },
  );
  if (!search.ok) throw new Error(`${query}: ${search.status} ${await search.text()}`);
  const result = (await search.json()).results[0];
  if (!result) throw new Error(`${query}: no Unsplash results`);
  const image = await fetch(`${result.urls.raw}&w=448&h=448&fit=crop&fm=jpg&q=70`, {
    signal: AbortSignal.timeout(30_000),
  });
  console.log(`  ${query}: photo by ${result.user?.name} (unsplash.com/@${result.user?.username})`);
  if (!image.ok) throw new Error(`Unsplash image failed: ${image.status}`);
  return Buffer.from(await image.arrayBuffer());
}

/** Manual command: ensure the selected published artwork exists. */
async function generateImageRecord(
  options: Options,
  input: {
    file: string;
    assetPrefix: string;
    mime: "jpeg" | "png";
    entries: string[];
    generate: (
      id: string,
      secrets: Record<string, string>,
    ) => Promise<{ bytes: Buffer; anchors?: z.infer<typeof AnimalAnchors> }>;
  },
) {
  const recipes = input.entries.map((id) => ({
    id,
    slug: `${input.assetPrefix}-${id.replaceAll(" ", "-")}`,
    extension: input.mime,
    generate: async () => input.generate(id, ctx.secrets),
  }));
  if (options.slug && !recipes.some((recipe) => recipe.slug === options.slug)) {
    throw new Error(`Unknown ${input.assetPrefix} slug: ${options.slug}`);
  }
  const ctx = await resolveEnvContext({
    envs: mobileWebsiteEnvs,
    dopplerProject: "os",
    env: "prd",
  });
  const result = await syncAssetManifest({
    manifestPath: join(FILTERS_DIR, input.file),
    recipes,
    store: createAssetStore({
      objectsUrl: `https://api.cloudflare.com/client/v4/accounts/${ctx.env.cloudflareAccountId}/r2/buckets/${ctx.env.workerName}-state/objects`,
      token: ctx.secrets.CLOUDFLARE_API_TOKEN,
    }),
    slug: options.slug,
    force: options.force || false,
  });
  console.log(
    `${input.assetPrefix}: ${result.kept} already uploaded, ${result.generated} generated`,
  );
  return result;
}

/** Check all built-in art; generate and upload only missing objects. The optional
 * Unsplash deck remains opt-in through `flashcards --style photo`. */
export async function all(options: Options = {}) {
  if (!options.slug || options.slug.startsWith("backdrop-")) await backdrops(options);
  if (!options.slug || options.slug.startsWith("animal-")) await animals(options);
  for (const style of ["cartoon", "encyclopaedia"] as const) {
    if (!options.slug || options.slug.startsWith(`${style}-`))
      await flashcards({ ...options, style });
  }
  if (options.slug && !/^(backdrop|animal|cartoon|encyclopaedia)-/.test(options.slug)) {
    throw new Error(`Unknown asset slug: ${options.slug}`);
  }
}
