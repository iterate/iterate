// The issuer's pages run in a browser, but this package type-checks as a Worker: the DOM lib's
// globals conflict with @cloudflare/workers-types. React declares the DOM element interfaces empty
// (@types/react global.d.ts); these are the members the pages use.
interface HTMLElement {
  focus(): void;
}
interface HTMLInputElement {
  value: string;
}
interface HTMLSelectElement {
  value: string;
}
