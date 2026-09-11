export type AppConfigVarParser<T> = (raw: string, name: string) => T;
export declare const appConfigVarParsers: {
    string: (raw: string, name: string) => string;
    stringRecord: (raw: string, name: string) => Record<string, string>;
};
export type AppConfigVarRow<T> = {
    name: `APP_CONFIG_${string}`;
    parse: AppConfigVarParser<T>;
} & ({
    required: true;
} | {
    default: T;
});
export type ParsedAppConfigVars<Rows extends Record<string, AppConfigVarRow<unknown>>> = {
    readonly [Field in keyof Rows]: Rows[Field] extends AppConfigVarRow<infer T> ? T : never;
};
export declare function parseAppConfigVars<Rows extends Record<string, AppConfigVarRow<unknown>>>(rows: Rows, vars: object): ParsedAppConfigVars<Rows>;
export declare const APP_CONFIG_VAR_ROWS: {
    readonly environmentName: {
        readonly name: "APP_CONFIG_ENVIRONMENT_NAME";
        readonly parse: (raw: string, name: string) => string;
        readonly required: true;
    };
    readonly projectHostnameBase: {
        readonly name: "APP_CONFIG_PROJECT_HOSTNAME_BASE";
        readonly parse: (raw: string, name: string) => string;
        readonly default: "localhost";
    };
    readonly projects: {
        readonly name: "APP_CONFIG_PROJECTS_JSON";
        readonly parse: (raw: string, name: string) => Record<string, string>;
        readonly default: {};
    };
    readonly customHostnames: {
        readonly name: "APP_CONFIG_CUSTOM_HOSTNAMES_JSON";
        readonly parse: (raw: string, name: string) => Record<string, string>;
        readonly default: {};
    };
};
export interface AppConfig {
    readonly environmentName: string;
    readonly deployId: string;
    readonly projectHostnameBase: string;
    readonly projects: Readonly<Record<string, string>>;
    readonly customHostnames: Readonly<Record<string, string>>;
}
export declare function parseAppConfig(vars: object, deployId?: string): AppConfig;
export type AppConfigVarName = (typeof APP_CONFIG_VAR_ROWS)[keyof typeof APP_CONFIG_VAR_ROWS]["name"];
export type AppConfigEnv = {
    CF_VERSION_METADATA?: {
        id: string;
    };
    DEPLOYMENT_ID?: string;
} & {
    [Name in AppConfigVarName]?: string;
};
export declare function appConfigOf(env: AppConfigEnv): AppConfig;
export declare function deploymentIdOf(env: {
    DEPLOYMENT_ID?: string;
}, platformVersionId: string | undefined): string;
