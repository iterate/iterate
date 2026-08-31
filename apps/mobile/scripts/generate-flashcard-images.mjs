// Regenerates one style set of toddler flashcard pictures for the camera
// filter, committed as data URIs in src/lib/filters/flashcards-<style>
// .generated.ts. Manual, not CI — needs API keys and is non-deterministic:
//
//   cd apps/os && doppler run -- sh -c 'cd ../mobile && node scripts/generate-flashcard-images.mjs cartoon'
//   cd apps/os && doppler run -- sh -c 'cd ../mobile && node scripts/generate-flashcard-images.mjs encyclopaedia'
//   cd apps/os && doppler run -- sh -c 'cd ../mobile && node scripts/generate-flashcard-images.mjs photo'
//
// cartoon + encyclopaedia use OPENAI_API_KEY (gpt-image-1); photo pulls real
// photographs from Unsplash and needs UNSPLASH_ACCESS_KEY (a free demo key
// from unsplash.com/developers is enough: 41 words, 50 requests/hour).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep in sync with the FLASHCARDS list in lib/filters/definitions.ts
// (color-swatch cards are drawn, not generated).
const WORDS = [
  "dog",
  "cat",
  "ball",
  "banana",
  "apple",
  "water",
  "milk",
  "baby",
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
];

const noun = (word) =>
  word === "water" ? "a glass of water" : word === "milk" ? "a glass of milk" : `a ${word}`;

const STYLES = {
  cartoon: {
    quality: "low",
    prompt: (word) =>
      `Cute, simple, friendly cartoon illustration of ${noun(word)} for a toddler flashcard. Single object centered, bold outlines, flat bright colors, plain solid very light background, no text, no letters, no people unless the word is baby.`,
  },
  encyclopaedia: {
    quality: "medium",
    prompt: (word) =>
      `A realistic photograph of ${noun(word)} for a children's picture encyclopedia. Single subject centered and filling most of the frame, plain softly-lit studio background, natural colors and real textures with fine detail, slight natural imperfections, shot on a DSLR. Absolutely not a drawing, painting, or illustration; no airbrushed or artificial look; no text.`,
  },
};

const style = process.argv[2];
if (!STYLES[style] && style !== "photo") {
  throw new Error(
    `Usage: generate-flashcard-images.mjs <${[...Object.keys(STYLES), "photo"].join("|")}>`,
  );
}

const scratch = mkdtempSync(join(tmpdir(), `flashcards-${style}-`));

function shrink(raw) {
  execFileSync("sips", [
    "-Z",
    "448",
    "-s",
    "format",
    "jpeg",
    "-s",
    "formatOptions",
    "62",
    raw,
    "--out",
    raw,
  ]);
  return readFileSync(raw).toString("base64");
}

async function generateAi(word) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: STYLES[style].prompt(word),
      size: "1024x1024",
      quality: STYLES[style].quality,
      output_format: "jpeg",
    }),
  });
  if (!response.ok) throw new Error(`${word}: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const raw = join(scratch, `${word}.jpg`);
  writeFileSync(raw, Buffer.from(payload.data[0].b64_json, "base64"));
  return shrink(raw);
}

async function generateUnsplash(word) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) throw new Error("UNSPLASH_ACCESS_KEY is not set");
  const search = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(word)}&orientation=squarish&per_page=1`,
    { headers: { Authorization: `Client-ID ${accessKey}` } },
  );
  if (!search.ok) throw new Error(`${word}: ${search.status} ${await search.text()}`);
  const result = (await search.json()).results[0];
  if (!result) throw new Error(`${word}: no Unsplash results`);
  const image = await fetch(`${result.urls.raw}&w=448&h=448&fit=crop&fm=jpg&q=70`);
  const raw = join(scratch, `${word}.jpg`);
  writeFileSync(raw, Buffer.from(await image.arrayBuffer()));
  console.log(`  ${word}: photo by ${result.user?.name} (unsplash.com/@${result.user?.username})`);
  return shrink(raw);
}

const generate = async (word) => {
  const base64 = style === "photo" ? await generateUnsplash(word) : await generateAi(word);
  console.log(`${word}: ${Math.round((base64.length * 3) / 4 / 1024)}KB`);
  return [word, base64];
};

// Modest parallelism to stay clear of rate limits.
const results = [];
for (let i = 0; i < WORDS.length; i += 4) {
  results.push(...(await Promise.all(WORDS.slice(i, i + 4).map(generate))));
}

const exportName = `FLASHCARD_IMAGES_${style.toUpperCase()}`;
const outPath = new URL(`../src/lib/filters/flashcards-${style}.generated.ts`, import.meta.url)
  .pathname;
writeFileSync(
  outPath,
  `// Generated by scripts/generate-flashcard-images.mjs ${style} — do not edit
// by hand. Toddler flashcard pictures inlined as data URIs. ONLY import via
// lib/filters/definitions.ts (the DOM-component side) — this must not ride
// into the native Hermes bundle.

export const ${exportName}: Record<string, string> = {
${results.map(([word, base64]) => `  ${JSON.stringify(word)}:\n    "data:image/jpeg;base64,${base64}",`).join("\n")}
};
`,
);
console.log(`wrote ${outPath} (${results.length} cards)`);
