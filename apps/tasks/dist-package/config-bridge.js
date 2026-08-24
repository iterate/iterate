export const TasksApp = {
    create(env, options) {
        const configuredOrigin = parseHttpsOrigin(options.proxy.origin, "Tasks app proxy origin");
        return {
            async fetch(request) {
                const itx = await env.ITX.get();
                try {
                    const denied = await itx.auth.get(options.auth).fetch(request);
                    if (denied)
                        return denied;
                    const override = await itx.kv.get(options.proxy.originOverrideKvKey);
                    let origin = configuredOrigin;
                    if (override) {
                        const description = `Tasks app proxy override from "${options.proxy.originOverrideKvKey}"`;
                        if (typeof override !== "string") {
                            throw new Error(`${description} must be one complete HTTPS origin: ${JSON.stringify(override)}`);
                        }
                        origin = parseHttpsOrigin(override, description);
                    }
                    const target = new URL(request.url);
                    target.protocol = origin.protocol;
                    target.host = origin.host;
                    const forwarded = new Request(target, request);
                    return await fetch(new Request(forwarded, { redirect: "manual" }));
                }
                finally {
                    itx[Symbol.dispose]();
                }
            },
        };
    },
};
function parseHttpsOrigin(value, description) {
    const invalidMessage = `${description} must be one complete HTTPS origin: ${value}`;
    let origin;
    try {
        origin = new URL(value);
    }
    catch {
        throw new Error(invalidMessage);
    }
    if (origin.protocol !== "https:" || origin.origin !== value)
        throw new Error(invalidMessage);
    return origin;
}
