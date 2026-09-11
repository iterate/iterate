# Public hostname latency samples — 5 September 2026

These are current, read-only public HTTP samples against the installed hostname
fixture. They are not cache-equivalence measurements and do not attribute any
latency to source loading, Cloudflare, TLS, or the application without a trace
join. The query uses a `Resolver` explicitly set to `1.1.1.1`; it neither
changes DNS nor overrides a host/IP.

Every request asserts HTTP 200 and exactly:

```json
{
  "context": "project-core-ingress-demo/",
  "url": "https://<host>/notes?q=1",
  "app": "<null for demo; anything for custom>",
  "forged": null
}
```

## Fresh-connection sample

At `2026-09-05T12:23:52.427Z`–`2026-09-05T12:24:22.484Z`, 40 requests
alternated between the two hosts (20 each). Each request used a new Undici
`Agent` and `connection: close`.

| Host                        |   n | failures | p50 wall |  p95 wall |  max wall |
| --------------------------- | --: | -------: | -------: | --------: | --------: |
| `demo.iterate2.com`         |  20 |        0 | 509.1 ms | 3035.2 ms | 3755.0 ms |
| `anything.iterate.computer` |  20 |        0 | 570.1 ms | 1692.6 ms | 3718.2 ms |

The 3.7-second maxima are observations only. This run does not prove a TLS
handshake, edge, source-allocation, or application cause.

## Reused-Agent diagnostic sample

At `2026-09-05T12:25:58.136Z`–`2026-09-05T12:26:06.638Z`, another 40
alternating requests reused one `Agent` (20 per host). All assertions passed.

| Host                        |   n | failures | p50 wall | p95 wall | max wall |
| --------------------------- | --: | -------: | -------: | -------: | -------: |
| `demo.iterate2.com`         |  20 |        0 | 209.1 ms | 276.6 ms | 442.7 ms |
| `anything.iterate.computer` |  20 |        0 | 182.8 ms | 287.4 ms | 622.1 ms |

Undici 7.29.0 exposes `undici:client:beforeConnect` and
`undici:client:connected`; its documentation says the latter is published
after a connection is established, not that it is a per-request event. In this
serial run the observed connection-established timestamps were 247.4 ms after
start for `demo.iterate2.com` and 938.8 ms for `anything.iterate.computer`.
The one request at or above 500 ms was request 2:

| Host                        |     wall | resolver time | observed connect interval | Ray ID                 |
| --------------------------- | -------: | ------------: | ------------------------: | ---------------------- |
| `anything.iterate.computer` | 622.1 ms |      308.1 ms |                  495.6 ms | `a3653840db62f4c1-LHR` |

The Ray ID is retained only for a subsequent Cloudflare wall-time join. No
cause is classified here; source allocation cost remains unproven.

### Cloudflare Worker join

A read-only Cloudflare query for the installed `c92` service, widened by two
seconds around this reusable-Agent window and matched by host/path, returned
all 40 outer Worker fetch rows: each was HTTP 200 with `ok` outcome. Their
Worker wall times were 22–81 ms and CPU times 1–5 ms. The slow client request
above, Ray `a3653840db62f4c1-LHR`, joined to a 23 ms / 1 ms CPU Worker row.

This locates the multi-hundred-millisecond excess outside Worker execution. It
does not identify a network, resolver, TLS, or client-runtime cause, and it
does not establish a source-allocation cost.

## Exact reproducible reusable-Agent command

Run from `packages/v3/project-core`:

```sh
node --input-type=module -e '
import diagnosticsChannel from "node:diagnostics_channel";
import { Resolver } from "node:dns";
import { Agent, fetch } from "undici";
const resolver=new Resolver(); resolver.setServers(["1.1.1.1"]);
const targets=[{host:"demo.iterate2.com",app:null},{host:"anything.iterate.computer",app:"anything"}];
let active; const connections=[];
const lookup=(hostname,options,callback)=>{const started=performance.now(); resolver.resolve4(hostname,(error,addresses)=>{const elapsed=performance.now()-started;if(active&&active.host===hostname) active.dnsMs=elapsed; if(error)return callback(error,[],4);callback(null,options.all?addresses.map(address=>({address,family:4})):addresses[0],4);});};
diagnosticsChannel.channel("undici:client:beforeConnect").subscribe(({connectParams})=>{if(active&&connectParams.hostname===active.host) active.connectStartedMs=performance.now();});
diagnosticsChannel.channel("undici:client:connected").subscribe(({connectParams})=>{const at=performance.now();if(active&&connectParams.hostname===active.host){active.connectedAtMs=at;active.connectMs=active.connectStartedMs===undefined?null:at-active.connectStartedMs;} connections.push({host:connectParams.hostname,atMs:at});});
const dispatcher=new Agent({connect:{lookup},connections:1,pipelining:1});
const samples=[]; const startIso=new Date().toISOString(); const start=performance.now();
for(let i=0;i<40;i++){const target=targets[i%2];const url=`https://${target.host}/notes?q=1`;active={n:i+1,host:target.host,url,startedMs:performance.now()-start,dnsMs:null,connectStartedMs:undefined,connectedAtMs:null,connectMs:null};const began=performance.now();try{const response=await fetch(url,{dispatcher,signal:AbortSignal.timeout(30000)});const body=await response.json();const expected={context:"project-core-ingress-demo/",url,app:target.app,forged:null};if(response.status!==200||JSON.stringify(body)!==JSON.stringify(expected))active.failure={status:response.status,body};active.rayId=response.headers.get("cf-ray");}catch(error){active.failure={error:String(error)};}active.wallMs=performance.now()-began;samples.push(active);active=undefined;}
const endIso=new Date().toISOString();await dispatcher.close();
const q=(values,p)=>values[Math.min(values.length-1,Math.ceil(values.length*p)-1)];const summary=Object.fromEntries(targets.map(({host})=>{const xs=samples.filter(x=>x.host===host);const ok=xs.filter(x=>!x.failure).map(x=>x.wallMs).sort((a,b)=>a-b);return[host,{count:xs.length,failures:xs.filter(x=>x.failure).length,p50Ms:+q(ok,.5).toFixed(1),p95Ms:+q(ok,.95).toFixed(1),maxWallMs:+Math.max(...xs.map(x=>x.wallMs)).toFixed(1)}]}));
console.log(JSON.stringify({startIso,endIso,total:samples.length,summary,connections:connections.map(x=>({host:x.host,atMs:+(x.atMs-start).toFixed(1)})),slow:samples.filter(x=>x.wallMs>=500).map(x=>({n:x.n,host:x.host,wallMs:+x.wallMs.toFixed(1),dnsMs:x.dnsMs===null?null:+x.dnsMs.toFixed(1),connectMs:x.connectMs===null?null:+x.connectMs.toFixed(1),rayId:x.rayId,failure:x.failure||null})),failures:samples.filter(x=>x.failure)},null,2));
'
```
