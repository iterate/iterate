import { createRequire as __iterateCreateRequire } from "node:module"; const require = __iterateCreateRequire("/opencode-workerd.js");
import{createHash as e}from"crypto";var r;(function(a){function s(t){return e("sha1").update(t).digest("hex")}a.fast=s;function n(t){return e("sha256").update(t).digest("hex")}a.sha256=n})(r||(r={}));export{r as a};
