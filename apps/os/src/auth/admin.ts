import type { AppConfig } from "~/config.ts";
import { adminPrincipal, type AdminPrincipal } from "~/auth/principal.ts";

function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue);
  const token = match?.[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

export function authenticateAdminBearer(input: {
  authorizationHeader: string | null;
  config: Pick<AppConfig, "adminApiSecret">;
}): AdminPrincipal | null {
  const expectedToken = input.config.adminApiSecret?.exposeSecret();
  const providedToken = readBearerToken(input.authorizationHeader);

  if (!expectedToken || !providedToken || providedToken !== expectedToken) {
    return null;
  }

  return adminPrincipal;
}

export function authenticateAdminApiSecret(
  context: { config: Pick<AppConfig, "adminApiSecret"> },
  request: Request,
): AdminPrincipal | null {
  return authenticateAdminBearer({
    authorizationHeader: request.headers.get("authorization"),
    config: context.config,
  });
}
