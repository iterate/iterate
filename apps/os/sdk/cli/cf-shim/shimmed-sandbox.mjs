// This is a file that will be loaded in place of @cloudflare/sandbox when running the CLI.

export class Sandbox {}
export const getSandbox = () => new Sandbox();
