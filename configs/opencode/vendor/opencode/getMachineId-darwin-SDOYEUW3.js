import { createRequire as __iterateCreateRequire } from "node:module"; const require = __iterateCreateRequire("/opencode-workerd.js");
import{a as i}from"./chunk-3R7PLWVZ.js";import{a as o}from"./chunk-V6UXJ6KU.js";import{e as d}from"./chunk-4ZAXVOX6.js";var n=d(o());async function a(){try{let t=(await i('ioreg -rd1 -c "IOPlatformExpertDevice"')).stdout.split(`
`).find(c=>c.includes("IOPlatformUUID"));if(!t)return;let r=t.split('" = "');if(r.length===2)return r[1].slice(0,-1)}catch(e){n.diag.debug(`error reading machine id: ${e}`)}}export{a as getMachineId};
