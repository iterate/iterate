import { DockerDeployment, type Deployment } from "@iterate-com/shared/jonasland/deployment";
import { ordersServiceManifest } from "@iterate-com/orders-contract";

export async function projectDeployment(params: { image: string; name?: string }) {
  const deployment = await DockerDeployment.create({
    image: params.image,
    name: params.name,
  });

  const orders = deployment.createServiceOrpcClient({
    manifest: ordersServiceManifest,
  });

  return Object.assign(deployment, { orders }) as Deployment & { orders: typeof orders };
}

export type SandboxFixture = Awaited<ReturnType<typeof projectDeployment>>;
