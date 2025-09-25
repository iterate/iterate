import Replicate from "replicate";
import { z } from "zod/v4";
import type { DB } from "../../db/client.ts";
import { getFilePublicURL, uploadFile } from "../../file-handlers.ts";

const DEFAULT_MODEL = "openai/gpt-image-1";

// Input schemas matching the tool definitions
export const GenerateImageInput = z.object({
  prompt: z.string(),
  model: z
    .string()
    .default(DEFAULT_MODEL)
    .describe("The image generation model to use. Only set this when explicitly asked to do so"),
  quality: z.enum(["standard", "high"]).default("high"),
  background: z.enum(["auto", "transparent", "opaque"]).default("auto"),
});

export const EditImageInput = z.object({
  input_images: z
    .array(z.string())
    .min(1, "URLs of images to edit. At least one image URL must be provided"),
  prompt: z.string(),
  model: z
    .string()
    .default(DEFAULT_MODEL)
    .describe("The image editing model to use. Only set this when explicitly asked to do so"),
  background: z.enum(["auto", "transparent", "opaque"]).default("auto"),
  quality: z.enum(["standard", "high"]).default("high"),
});

export type GenerateImageInput = z.infer<typeof GenerateImageInput>;
export type EditImageInput = z.infer<typeof EditImageInput>;

// Response types
export interface ImageGenerationResult {
  iterateFileId: string;
  imageURL: string;
  revisedPrompt: undefined;
  originalPrompt: string;
  fileRecord: {
    id: string;
    openAIFileId?: string;
    mimeType: string;
  };
}

export interface ImageEditResult extends ImageGenerationResult {
  responseId: string;
}

// Dependencies interface
export interface ReplicateIntegrationDeps {
  replicateApiToken: string;
  openaiApiKey: string;
  iterateUser?: string;
  estateId: string;
  db: DB;
}

// Get URL from Replicate result handling multiple of their responses
function extractImageURLFromReplicateResult(result: unknown): string {
  if (Array.isArray(result)) {
    if (result.length === 0) {
      throw new Error("Replicate API returned empty array");
    }
    const firstResult = result[0];
    if (typeof firstResult === "string") {
      return firstResult;
    } else if (
      firstResult &&
      typeof firstResult === "object" &&
      "url" in firstResult &&
      typeof (firstResult as any).url === "function"
    ) {
      return (firstResult as any).url();
    } else if (
      firstResult &&
      typeof firstResult === "object" &&
      "url" in firstResult &&
      typeof (firstResult as any).url === "string"
    ) {
      return (firstResult as any).url;
    } else {
      throw new Error(`Unexpected array element format: ${JSON.stringify(firstResult)}`);
    }
  } else if (typeof result === "string") {
    return result;
  } else if (
    result &&
    typeof result === "object" &&
    "url" in result &&
    typeof (result as any).url === "function"
  ) {
    return (result as any).url();
  } else if (
    result &&
    typeof result === "object" &&
    "url" in result &&
    typeof (result as any).url === "string"
  ) {
    return (result as any).url;
  } else {
    console.error("Full result object:", result);
    throw new Error(
      `Unexpected Replicate response format: ${JSON.stringify(result)}. Expected string, array, or object with url property/method.`,
    );
  }
}

function replaceLocalhostWithNgrok(url: string, iterateUser: string | undefined): string {
  if (!iterateUser || !url.includes("localhost")) {
    return url;
  }
  return url
    .replace("localhost:5173", `${iterateUser}.dev.iterate.com`)
    .replace("http://", "https://");
}

async function downloadAndUploadImage(
  imageURL: string,
  filename: string,
  deps: ReplicateIntegrationDeps,
) {
  const resp = await fetch(imageURL);
  if (!resp.ok) {
    throw new Error(`Failed to download image from Replicate: ${resp.status} ${resp.statusText}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());

  const fileRecord = await uploadFile({
    estateId: deps.estateId,
    stream: bytes,
    filename,
    contentType: "image/png",
    db: deps.db,
  });

  const finalPublicURL = replaceLocalhostWithNgrok(
    getFilePublicURL(fileRecord.id),
    deps.iterateUser,
  );

  return {
    fileRecord,
    finalPublicURL,
  };
}

export async function generateImage(
  input: GenerateImageInput,
  deps: ReplicateIntegrationDeps,
): Promise<ImageGenerationResult> {
  try {
    const replicate = new Replicate({
      auth: deps.replicateApiToken,
    });

    const replicateInput = {
      prompt: input.prompt,
      quality: input.quality,
      background: input.background,
      output_format: "png",
      openai_api_key: deps.openaiApiKey,
    };

    const result = await replicate.run(input.model as any, {
      input: replicateInput,
    });

    const imageURL = extractImageURLFromReplicateResult(result);
    const filename = `generated-image-${Date.now()}.png`;

    const { fileRecord, finalPublicURL } = await downloadAndUploadImage(imageURL, filename, deps);

    return {
      iterateFileId: fileRecord.id,
      imageURL: finalPublicURL,
      revisedPrompt: undefined,
      originalPrompt: input.prompt,
      fileRecord: {
        id: fileRecord.id,
        openAIFileId: fileRecord.openAIFileId ?? undefined,
        mimeType: "image/png",
      },
    };
  } catch (error) {
    console.error("❌ Image generation failed:", error);
    throw new Error(
      `Image generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

export async function editImage(
  input: EditImageInput,
  deps: ReplicateIntegrationDeps,
): Promise<ImageEditResult> {
  try {
    const replicate = new Replicate({
      auth: deps.replicateApiToken,
    });

    // Replace localhost URLs with ngrok URLs for the input images
    const processedImageURLs = input.input_images.map((url) =>
      replaceLocalhostWithNgrok(url, deps.iterateUser),
    );

    const replicateInput = {
      prompt: input.prompt,
      input_images: processedImageURLs,
      openai_api_key: deps.openaiApiKey,
    };

    console.log("replicateInput", replicateInput);
    const result = await replicate.run(input.model as any, {
      input: replicateInput,
    });

    const editedImageURL = extractImageURLFromReplicateResult(result);
    const filename = `edited-image-${Date.now()}.png`;

    const { fileRecord, finalPublicURL } = await downloadAndUploadImage(
      editedImageURL,
      filename,
      deps,
    );

    return {
      iterateFileId: fileRecord.id,
      imageURL: finalPublicURL,
      revisedPrompt: undefined,
      originalPrompt: input.prompt,
      responseId: `resp_${Date.now()}`,
      fileRecord: {
        id: fileRecord.id,
        openAIFileId: fileRecord.openAIFileId ?? undefined,
        mimeType: "image/png",
      },
    };
  } catch (error) {
    console.error("❌ Image editing failed:", error);
    throw new Error(
      `Image editing failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
