import {
  PublicIngressUrlError,
  resolvePublicIngressUrl,
  type PublicIngressUrlType,
} from "@iterate-com/shared/jonasland/ingress-url";

type PublicBaseHostType = PublicIngressUrlType;

interface ResolvePublicUrlInput {
  ITERATE_INGRESS_HOST?: string;
  ITERATE_INGRESS_ROUTING_TYPE?: PublicBaseHostType;
  ITERATE_INGRESS_DEFAULT_APP?: string;
  internalURL: string;
}

export class ResolvePublicUrlError extends PublicIngressUrlError {
  override name = "ResolvePublicUrlError";
}

export function resolvePublicUrl(input: ResolvePublicUrlInput): string {
  try {
    return resolvePublicIngressUrl({
      ingressHost: input.ITERATE_INGRESS_HOST,
      ingressRoutingType: input.ITERATE_INGRESS_ROUTING_TYPE,
      defaultIngressAppSlug: input.ITERATE_INGRESS_DEFAULT_APP,
      internalUrl: input.internalURL,
    });
  } catch (error) {
    if (error instanceof PublicIngressUrlError) {
      throw new ResolvePublicUrlError(error.message);
    }
    throw error;
  }
}
