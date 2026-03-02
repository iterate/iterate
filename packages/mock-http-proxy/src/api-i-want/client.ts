import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

async function main(): Promise<void> {
  console.log("Client sending through HTTPS_PROXY");
  console.log(`HTTPS_PROXY=${process.env.HTTPS_PROXY ?? "<unset>"}`);

  const response = await fetch("https://httpbin.org/anything?demo=double-proxy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      hello: "from client through MITM -> egress",
    }),
  });

  const payload = (await response.json()) as unknown;
  console.log("Final response JSON:");
  console.dir(payload, { depth: null });
}

void main().catch((error) => {
  console.error("Client request failed", error);
  process.exitCode = 1;
});
