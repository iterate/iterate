// The user-message describer's facet entry point: the reusable derivation
// processor lives in the published package (iterate/processors
// user-message-describer.ts — parses the html attachment vocabulary out of
// user chat messages into typed render facts); this file only gives the
// facet loader a class to build in this config repo. Installed on each agent
// stream by worker.ts.
import { StreamProcessorFacet, type ProcessorHostDeps } from "iterate/sdk";
import { UserMessageDescriberProcessor } from "iterate/processors";

export class UserMessageDescriberFacet extends StreamProcessorFacet {
  protected createProcessor(deps: ProcessorHostDeps) {
    return new UserMessageDescriberProcessor(deps);
  }
}
