import { WorkerEntrypoint } from "cloudflare:workers";

export type DynamicWorkerEgressGatewayProps = {
  secretHeaderName: string;
  secretHeaderValue: string;
};

export class DynamicWorkerEgressGateway extends WorkerEntrypoint<
  Env,
  DynamicWorkerEgressGatewayProps
> {
  fetch(request: Request) {
    const headers = new Headers(request.headers);
    headers.set(this.ctx.props.secretHeaderName, this.ctx.props.secretHeaderValue);

    return fetch(
      new Request(request, {
        headers,
      }),
    );
  }
}
