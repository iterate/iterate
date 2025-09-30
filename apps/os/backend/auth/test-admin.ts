export const parseCredentials = (credentials: string) => {
  const atIndex = credentials.indexOf("@");
  const errorMessage = "Invalid credentials. Expected format is email@example.com:passwerd123";
  if (atIndex === -1) throw new Error(errorMessage);

  const colonIndex = credentials.indexOf(":", atIndex);
  if (colonIndex === -1) throw new Error(errorMessage);

  return {
    credentials,
    email: credentials.slice(0, colonIndex),
    password: credentials.slice(colonIndex + 1),
  };
};

/**
 * Struct with email and password for a test admin user *if and only if* there's an environment variable set for it
 * We should not set such an environment variable in production.
 */
export const testAdminUser = import.meta.env.VITE_TEST_ADMIN_CREDENTIALS
  ? ({ enabled: true, ...parseCredentials(import.meta.env.VITE_TEST_ADMIN_CREDENTIALS) } as const)
  : ({ enabled: false, credentials: null, email: null, password: null } as const);
