// The app's one answer to "am I signed in, where, and as whom?".
//
// Sign-in is app-global: it belongs to a deployment, not to a screen or a
// project. Before this, every screen re-derived it from the keychain at its
// own callsite, so a screen outside a project could render "not signed in"
// while the app plainly was. One query key, invalidated by the three things
// that can actually change it: sign-in, sign-out, and switching servers.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSignedInEmail, hasSignIn, signIn, signOut } from "./auth.ts";
import { disconnectItxSession, reconnectItxSession } from "./itx.ts";
import { DEFAULT_SERVER } from "./servers.ts";
import { getServerBaseUrl, setServerBaseUrl } from "./storage.ts";

export type Session = {
  /** The deployment the app is pointed at. Always a real URL. */
  serverBaseUrl: string;
  signedIn: boolean;
  /** The signed-in identity on `serverBaseUrl`, when its token carries one. */
  email: string | null;
};

export const sessionKey = ["session"];

async function readSession(): Promise<Session> {
  const serverBaseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
  const signedIn = await hasSignIn(serverBaseUrl);
  return {
    serverBaseUrl,
    signedIn,
    email: signedIn ? await getSignedInEmail(serverBaseUrl) : null,
  };
}

/** The app-global session. Pending until the keychain read lands. */
export function useSession() {
  return useQuery({ queryKey: sessionKey, queryFn: readSession, staleTime: Infinity });
}

/**
 * Who a DIFFERENT deployment would sign you in as — what a server switch would
 * land on. Deliberately separate from `useSession`: it is a fact about
 * somewhere else, and conflating the two is what produced the old
 * "not signed in" claim about a server the user never chose.
 */
export function useSessionOn(baseUrl: string | null) {
  return useQuery({
    queryKey: ["session-on", baseUrl],
    queryFn: () => getSignedInEmail(baseUrl!),
    enabled: baseUrl !== null,
    staleTime: Infinity,
  });
}

export type SignInInput = { baseUrl: string; loginHint: string | null };

/** Sign in on a deployment and make it the app's server. Every cached read
 * belongs to the old identity, so the cache is dropped wholesale. */
export function useSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ baseUrl, loginHint }: SignInInput) => {
      await setServerBaseUrl(baseUrl);
      await signIn(baseUrl, loginHint ? { loginHint } : {});
      return baseUrl;
    },
    onSuccess: (baseUrl) => {
      reconnectItxSession(baseUrl);
      queryClient.clear();
    },
  });
}

/** Point the app at a deployment it is already signed in to — no OAuth hop. */
export function useUseServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (baseUrl: string) => {
      await setServerBaseUrl(baseUrl);
      return baseUrl;
    },
    onSuccess: (baseUrl) => {
      reconnectItxSession(baseUrl);
      queryClient.clear();
    },
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (baseUrl: string) => {
      await signOut(baseUrl);
    },
    onSuccess: () => {
      disconnectItxSession();
      queryClient.clear();
    },
  });
}
