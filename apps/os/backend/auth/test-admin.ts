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
