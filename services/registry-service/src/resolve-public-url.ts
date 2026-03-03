import {
  PublicIngressUrlError,
  resolvePublicIngressUrl,
  type PublicIngressUrlType,
} from "@iterate-com/shared/jonasland/ingress-url";

export type PublicBaseUrlType = PublicIngressUrlType;

export interface ResolvePublicUrlInput {
  ITERATE_PUBLIC_BASE_URL?: string;
  ITERATE_PUBLIC_BASE_URL_TYPE?: PublicBaseUrlType;
  internalURL: string;
}

export class ResolvePublicUrlError extends PublicIngressUrlError {
  override name = "ResolvePublicUrlError";
}

export function resolvePublicUrl(input: ResolvePublicUrlInput): string {
  try {
    return resolvePublicIngressUrl({
      publicBaseUrl: input.ITERATE_PUBLIC_BASE_URL,
      publicBaseUrlType: input.ITERATE_PUBLIC_BASE_URL_TYPE,
      internalUrl: input.internalURL,
    });
  } catch (error) {
    if (error instanceof PublicIngressUrlError) {
      throw new ResolvePublicUrlError(error.message);
    }
    throw error;
  }
}
