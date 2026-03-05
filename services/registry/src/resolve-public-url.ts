import {
  PublicIngressUrlError,
  resolvePublicIngressUrl,
  type PublicIngressUrlType,
} from "@iterate-com/shared/jonasland/ingress-url";

export type PublicBaseHostType = PublicIngressUrlType;

export interface ResolvePublicUrlInput {
  ITERATE_PUBLIC_BASE_HOST?: string;
  ITERATE_PUBLIC_BASE_HOST_TYPE?: PublicBaseHostType;
  internalURL: string;
}

export class ResolvePublicUrlError extends PublicIngressUrlError {
  override name = "ResolvePublicUrlError";
}

export function resolvePublicUrl(input: ResolvePublicUrlInput): string {
  try {
    return resolvePublicIngressUrl({
      publicBaseHost: input.ITERATE_PUBLIC_BASE_HOST,
      publicBaseHostType: input.ITERATE_PUBLIC_BASE_HOST_TYPE,
      internalUrl: input.internalURL,
    });
  } catch (error) {
    if (error instanceof PublicIngressUrlError) {
      throw new ResolvePublicUrlError(error.message);
    }
    throw error;
  }
}
