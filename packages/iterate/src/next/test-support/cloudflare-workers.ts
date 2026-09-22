/** Node test replacement for the Workers base class used by app-session.ts. */
export class DurableObject {
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: unknown,
  ) {}
}
