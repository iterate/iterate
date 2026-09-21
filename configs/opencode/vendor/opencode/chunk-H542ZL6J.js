import { createRequire as __iterateCreateRequire } from "node:module"; const require = __iterateCreateRequire("/opencode-workerd.js");
import{Eb as z,Gb as x,ka as $,la as A,ub as F,w as R,wb as _}from"./chunk-GJJL4OC6.js";var M="~effect/encoding/Sse/SseError",C=class extends x("EventTooLarge"){get message(){return`Pending SSE event exceeded the maximum size of ${this.maxEventSize}`}},y=class extends x("SseError"){[M]=M;get message(){return this.reason.message}},O=10*1024*1024;function j(r,a){let w=a?.maxEventSize??O,g,t,m,p,u,h,S,l;return E(),{feed:I,reset:E};function E(){g=!0,t="",m=0,p=-1,u=!1,h=void 0,S=void 0,l=""}function I(d){t=t?t+d:d,g&&t.startsWith(P)&&(t=t.slice(P.length)),g=!1;let o=t.length,e=0;for(;e<o;){u&&(t[e]===`
`&&++e,u=!1);let n=-1,c=p,i;for(let s=m;n<0&&s<o;++s)i=t[s],i===":"&&c<0?c=s-e:i==="\r"?(u=!0,n=s-e):i===`
`&&(n=s-e);if(n<0){m=o-e,p=c;break}else m=0,p=-1;b(t,e,c,n),e+=n+1}if(e===o?t="":e>0&&(t=t.slice(e)),t.length+l.length>w){let n=new y({reason:new C({maxEventSize:w})});return E(),n}}function b(d,o,e,n){if(n===0){l.length>0&&(r({_tag:"Event",id:h,event:S||"message",data:l.slice(0,-1)}),l=""),S=void 0;return}let c=e<0,i=d.slice(o,o+(c?n:e)),s=0;c?s=n:d[o+e+1]===" "?s=e+2:s=e+1;let D=o+s,N=n-s,f=d.slice(D,D+N).toString();if(i==="data")l+=f?`${f}
`:`
`;else if(i==="event")S=f;else if(i==="id"&&!f.includes("\0"))h=f;else if(i==="retry"&&/^\d+$/.test(f)){let k=parseInt(f,10);r(new T({duration:F(k),lastEventId:h}))}}}var P="\uFEFF";var v="~effect/encoding/Sse/Retry",T=class r extends z("Retry"){[v]=v;static is(a){return R(a,v)}static filter(a){return r.is(a)?$(a):A(a)}},q={write(r){switch(r._tag){case"Event":{let a="";return r.id!==void 0&&(a+=`id: ${r.id}
`),r.event!=="message"&&(a+=`event: ${r.event}
`),a+=`data: ${r.data.replace(/\n/g,`
data: `)}
`,a+`
`}case"Retry":return`retry: ${_(r.duration)}

`}}};export{j as a,q as b};
