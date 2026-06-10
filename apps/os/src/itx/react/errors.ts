// The browser face of the kernel's error module. ItxError codes cross
// capnweb as own enumerable props on a reconstructed Error (class identity
// does not survive), so detection is duck-typed — see ~/itx/errors.ts for
// the wire mechanics, code taxonomy, and masking policy.

export { getItxErrorCode, isItxAccessError, type ItxErrorCode } from "../errors.ts";
