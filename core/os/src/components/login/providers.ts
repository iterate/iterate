import { INTEGRATION_PROVIDER_NAMES } from "iterate/api";

/** One way to sign in through another identity provider: `key` is what a link's `provider_hint`
 *  names it by. */
export type SignInProvider = { key: string; name: string; href: string; logo: string };

/** The identity providers this deployment accepts, each with the link that starts its sign-in.
 *  `adminIssuer` is another iterate deployment its admins sign in through (admin-sign-in.ts), named
 *  and keyed by its host. */
export function signInProvidersOf(state: {
  google: string | null;
  cloudflare: string | null;
  github: string | null;
  adminIssuer: { host: string; href: string } | null;
}): SignInProvider[] {
  const providers = [
    {
      key: "google",
      name: INTEGRATION_PROVIDER_NAMES.google,
      href: state.google,
      logo: "/google-logo.svg",
    },
    {
      key: "github",
      name: INTEGRATION_PROVIDER_NAMES.github,
      href: state.github,
      logo: "/github-logo.svg",
    },
    {
      key: "cloudflare",
      name: INTEGRATION_PROVIDER_NAMES.cloudflare,
      href: state.cloudflare,
      logo: "/cloudflare-logo.svg",
    },
    {
      key: state.adminIssuer?.host || "",
      name: state.adminIssuer?.host || "",
      href: state.adminIssuer?.href || null,
      logo: "/iterate-logo.svg",
    },
  ];
  return providers.flatMap((provider) =>
    provider.href ? [{ ...provider, href: provider.href }] : [],
  );
}
