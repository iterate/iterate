export const SIGN_IN_AUTH_ERRORS = ["session_verification_failed"] as const;

export type SignInAuthError = (typeof SIGN_IN_AUTH_ERRORS)[number];
