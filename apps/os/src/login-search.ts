import { z } from "zod";

const optionalString = z.string().optional().catch(undefined);

/** Query parameters the sign-in page carries across server renders and form redirects. Anything
 *  else, or a value that is not a string, is dropped rather than refused. */
const LoginSearch = z
  .object({
    next: optionalString,
    error: optionalString,
    email: optionalString,
    method: optionalString,
  })
  .catch({});

export const loginSearchOf = (search: unknown) => LoginSearch.parse(search);
