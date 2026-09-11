import { WorkerEntrypoint } from "cloudflare:workers";
import { BundleInput, type BuildResult, type CheckResult } from "./8baa80389791d8263744";
export { Bundler };
export default class Bundler extends WorkerEntrypoint<{
    BUILD_CACHE: KVNamespace;
    VERSION?: {
        id: string;
    };
    DEPLOYMENT_ID?: string;
}> {
    build(value: BundleInput): Promise<BuildResult>;
    check(value: BundleInput): CheckResult;
    fetch(): Response;
}
