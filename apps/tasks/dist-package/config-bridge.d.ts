import { RpcTarget } from "cloudflare:workers";
type TasksAppOptions = {
    auth: {
        policy: "project-member";
    };
    proxy: {
        origin: string;
        originOverrideKvKey: string;
    };
};
export type TasksLinkInput = {
    /** Absolute /workspaces/** stream path of the workspace the board renders. */
    workspace: string;
    /** Absolute /repos/** path of the repo whose task files the board shows. */
    repo: string;
    /** Repo-relative task file to open (a .md file under a `tasks/` folder). */
    task?: string;
};
type TasksProject = {
    [Symbol.dispose](): void;
    appUrl(appSlug: string): Promise<string>;
    auth: {
        get(policy: {
            policy: "project-member";
        }): {
            fetch(request: Request): Promise<Response | null>;
        };
    };
    kv: {
        get(key: string): Promise<unknown>;
    };
};
type TasksEnv = {
    ITX: {
        get(): Promise<TasksProject>;
    };
};
/** Project-side capability exposed by config workers as `itx.worker.tasks`. */
export declare class TasksAppRpcTarget extends RpcTarget {
    #private;
    constructor(env: TasksEnv);
    /** Build a board URL for one workspace's task files under one repo. */
    link(input: TasksLinkInput): Promise<string>;
}
export declare const TasksApp: {
    create(env: TasksEnv, options: TasksAppOptions): {
        rpc: TasksAppRpcTarget;
        fetch(request: Request): Promise<Response>;
    };
};
export declare function requireWorkspacePath(value: string): string;
/** A board's repo path is a fully qualified /repos/** mount path — the SAME
 * rule the board applies on open (normalizeRepoPath), so a minted link can
 * never carry a repo the route would reject. */
export declare function requireRepoPath(value: string): string;
/** A task path is repo-relative: a Markdown file below a `tasks/` folder. */
export declare function requireTaskPath(value: string): string;
export {};
