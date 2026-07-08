// The itx-facing data shapes for the Cloudflare first-party platform
// capabilities (Workers AI markdown conversion, Browser Run, Images, Media
// Transformations). The capability surfaces themselves are the RpcTarget
// classes in rpc-targets.ts (AiRpcTarget, CfBrowserCapabilityRpcTarget, …);
// these are the input/output shapes their signatures publish.

export type CfMarkdownDocument = {
  /** Filename including the extension; Cloudflare uses it to choose the converter. */
  name: string;
  blob: Blob;
};

export type CfMarkdownConversionOptions = {
  conversionOptions?: {
    html?: {
      cssSelector?: string;
      hostname?: string;
    };
    image?: {
      descriptionLanguage?: string;
    };
    pdf?: {
      excludeMetadata?: boolean;
    };
  };
};

export type CfMarkdownConversionResult = {
  name: string;
  format: "markdown" | "error";
  mimeType?: string;
  tokens?: number;
  data?: string;
  error?: string;
};

export type CfMarkdownSupportedFormat = {
  extension: string;
  mimeType: string;
};

export type CfMarkdownConversionArgs =
  | []
  | [documents: CfMarkdownDocument | CfMarkdownDocument[], options?: CfMarkdownConversionOptions];

export type CfBrowserQuickAction =
  | "content"
  | "screenshot"
  | "pdf"
  | "markdown"
  | "snapshot"
  | "scrape"
  | "json"
  | "links"
  | "crawl";

export type CfBrowserQuickActionOptions = Record<string, unknown> &
  ({ url: string } | { html: string });

export type CfImageTransformOptions = Record<string, unknown>;

export type CfImageOutputOptions = { format: string } & Record<string, unknown>;

export type CfImageDrawOptions = Record<string, unknown>;

export type CfImageTransformInput = {
  image: ReadableStream<Uint8Array>;
  transforms?: CfImageTransformOptions[];
  draws?: Array<{
    image: ReadableStream<Uint8Array>;
    options?: CfImageDrawOptions;
    transforms?: CfImageTransformOptions[];
  }>;
  output: CfImageOutputOptions;
};

export type CfVideoTransformOptions = Record<string, unknown>;

export type CfVideoOutputOptions = {
  mode: "video" | "spritesheet" | "frame" | "audio";
} & Record<string, unknown>;

export type CfVideoTransformInput = {
  video: ReadableStream<Uint8Array>;
  transform?: CfVideoTransformOptions;
  output: CfVideoOutputOptions;
};
