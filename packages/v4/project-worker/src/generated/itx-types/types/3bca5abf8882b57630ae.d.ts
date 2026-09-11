import { RpcTarget } from "./69744e22e20f005565f2";
import type { ItxExpression } from "./080e8cd0d44c438e565a";
export declare class InvokeHandle extends RpcTarget {
    #private;
    constructor(dispatchItxExpressionSteps: (itxExpressionSteps: ItxExpression) => unknown);
    invoke(itxExpressionSteps: ItxExpression): unknown;
    applyRoot(args: unknown[]): unknown;
}
export declare function walkStepsOnRpcStub(stub: unknown, steps: ItxExpression): unknown;
export declare class FacetHandle extends InvokeHandle {
}
export declare class RpcStubHandle extends InvokeHandle {
}
