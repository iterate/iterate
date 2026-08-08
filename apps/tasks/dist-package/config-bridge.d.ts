type TasksAppOptions = {
    auth: {
        policy: "project-member";
    };
    proxy: {
        origin: string;
        originOverrideKvKey: string;
    };
};
type TasksProject = {
    [Symbol.dispose](): void;
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
export declare const TasksApp: {
    create(env: {
        ITX: {
            get(): Promise<TasksProject>;
        };
    }, options: TasksAppOptions): {
        fetch(request: Request): Promise<Response>;
    };
};
export {};
