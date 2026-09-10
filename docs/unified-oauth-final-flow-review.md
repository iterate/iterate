# Final deployed-flow review — Claude Fable 5.1 xhigh

2026-09-10. Model `claude-fable-5-1`, effort `xhigh`, tools disabled; completed successfully in 531 seconds without permission denials.

Disposition: keep the form search codec and async session loader. Both deployed browser tests subsequently passed, and the first-consent test also passed locally. The personal-token callback already explicitly sets a 30-day access-token TTL, capped by the grant deadline; a regression now reads the real provider token expiry to prove it agrees with the displayed deadline. Google callback registration remains external work.

The Notes proxy does not trust a forwarded origin header: the project edge handles OAuth and `/api` on the request's real project origin before invoking the config worker. The config worker changes the upstream URL to Notes for the shared public SPA shell and assets; browser RPC stays on the current origin. Direct Notes requests use their own cookie/session and the same-origin API gate. The deployed bearer-ingress test proves forged principal headers are replaced and credentials stripped.

Optional builder/redirect helpers would trade small literal repetition for more indirection; kept the current explicit authorization sites. Cleanup pagination remains a potential UX improvement for inventories exceeding one page with failed cleanup; no pending cleanup remains in this deployment. The codec preserves OAuth semantics, not arbitrary original percent-encoding or interleaved key order.

---

**Verdict:** both fixes are correct and minimal. I found no blocking bug in the connected flow. The blockers are verification and one external registration.

**Blockers**

- **Run the two pending browser tests.** The codec and the async loader are right by inspection, but neither has been exercised on the deployment yet. The Claude repeated-resource test and the Sessions route are the only two things standing between you and a fully verified flow.
- **Google redirect URI registration.** Register the exact callback URL the server generates, scheme and path included, in the Google client. Mock-signed claims pass, so this is configuration, not code.
- **Personal token expiry is asserted, not observed.** The mint method returns a locally computed thirty-day expiry and discards the provider's expiry field. If the token exchange callback does not set a thirty-day access token TTL for personal grants, the UI text is false and the token dies at the provider default. Smallest fix: parse the provider's `expires_in` and derive the returned expiry from it. That also removes one parallel computation.

**Search codec**

- Correct, and the shape matches what Start's server canonicalization needs. Repeated keys must be preserved as arrays, or the canonical redirect would drop a resource. A last-wins codec is therefore not an option.
- It is not byte-preserving in general. Clients that encode spaces as `%20` or interleave repeated keys get one harmless 307 to the form-canonical URL. Decoding matches the provider, so semantics survive. The test's URL is already canonical, so its byte-equality assertions hold.
- Do not replace it with the router's built-in helpers. Their decoder coerces numeric and boolean-looking strings, which is exactly the corruption you are avoiding.
- Optional nit: iterate `new Set(params.keys())` instead of `params.keys()`, which yields duplicates for repeated keys.
- Consequence to remember: every search value is now a string. Any future `validateSearch` must coerce numbers itself. Both current routes are string-only.

**Async loader**

- Appropriate and idiomatic. An RpcPromise is a callable proxy, so the router's promise check rejects it. Wrapping in an async function is the smallest normalization. The inner `await` is redundant but harmless and matches the comment. The same rule applies to any loader or `beforeLoad` that returns an RPC call directly. The shared dashboard loader already complies.

**Lifetime and seam check**

- Issuer, app and personal grants, the browser session DO, the cookie and the pending window all agree on thirty days and ten minutes. Nothing is needlessly different in value. The thirty-day figure is spelled out in five places.
- A live socket ends at access token expiry while HTTP calls refresh silently through the DO. An in-page action after an idle hour fails once, then the next navigation reconnects. This is coherent and I recommend leaving it.
- Not visible in the excerpt: how the Notes worker recovers the project-host origin behind the proxy. The passing test proves it works. Only confirm that a direct visitor to notes.iterate2.com cannot supply that origin themselves.

**Optional simplifications**

- **One grant props builder.** A `grantProps(kind, user, projects)` helper in oauth.ts collapses three near-identical literals and holds the single lifetime constant.
- **One client error redirect helper.** The deny link in describe and the failure mapper build the same four-parameter redirect. One function, two call sites.
- **Sessions inventory cleanup rows.** Pending-cleanup rows are appended to every page and can duplicate a grant that appears on a later page. Append them only on the first page.
- **Self-approval tail.** Issuer sign-in and token minting share the parse, approve, extract-code sequence. A small helper would remove one block. Low value. Leave it unless you touch that code again.
