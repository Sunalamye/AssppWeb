# State transitions and diagnostics

This document describes the stateful paths reviewed in the November 2026 authentication, purchase, and download investigation. A successful HTTP exchange is not evidence that Apple authenticated an account or granted an app license.

## Reading a failed operation

1. Find the `[flow: <UUID>]` shown with the error. The same ID follows account renewal, device proof, purchase, download discovery, and backend enqueue.
2. In Cloudflare Observability, select the **Containers** dataset and the `assppweb-assppcontainer` application. Find `asspp.diagnostic` events containing that flow ID. Worker invocation logs remain useful for request status and deployment/runtime errors.
3. Read `stage`, `outcome`, `reason`, `httpStatus`, and `errorCode`. For purchase failures, also read `purchaseBranch` and the response-shape fields below. Browser `sequence` orders events within its flow; server/helper `requestId` identifies individual backend operations. Different emitters have independent sequence counters. Use timestamps plus source/request ID when combining them.
4. If a browser log could not reach the server, open **Settings → Diagnostics → Export diagnostics**. The export contains the latest 200 safe events retained by that browser.

Container logs use the application's UUID as `$metadata.service`, not its display name. When using the Cloudflare telemetry API, discover this value through `/workers/observability/telemetry/values` or `/workers/observability/usage` and query the `containers` dataset. A Worker and its Durable Object can emit two records for the same request; compare trace/ray IDs before counting them as separate attempts.

### What one event means

```json
{
  "event": "asspp.diagnostic",
  "source": "browser",
  "schema": 1,
  "flowId": "b7d29fb5-64fe-45c9-9cf4-182031b45a89",
  "sequence": 9,
  "flow": "license",
  "stage": "purchase",
  "outcome": "failure",
  "at": 1795488000000,
  "httpStatus": 200,
  "responseType": "buyProductFailure",
  "reason": "terms_required"
}
```

This example means the browser received an HTTP 200 response that requires a user action. It does **not** mean the purchase succeeded. Browser diagnostics are client reports, not an authorization mechanism. Only the protocol's explicit success criteria can advance an operation to success.

The diagnostic upload endpoint itself returns HTTP 204 when it accepts an event. This is normal and is separate from an Apple authentication response with `endpoint: "native_auth"` and `httpStatus: 204`.

### Distinguishing an unknown purchase response

An operation can complete authentication and save the renewed account, then receive HTTP 200 from `buyProduct` without receiving a license. Inspect the first `purchase` failure rather than treating the preceding authentication success as purchase success.

| Field                                              | What it establishes                                                                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purchaseBranch`                                   | The precise validation or interpretation branch, such as `dialog_present`, `invalid_status`, or `missing_success_document`.                                                                                 |
| `dialogCode`                                       | A bounded Apple-style identifier copied only from `metrics.dialogId`, when it matches the permitted namespace and identifier syntax. It is a diagnostic label, not permission to follow an action or retry. |
| `failureTypeKind`                                  | Whether `failureType` was missing, empty, numeric, text, or an invalid type. An absent numeric `errorCode` alone does not establish that Apple omitted `failureType`.                                       |
| `statusKind`                                       | Whether the status was missing, numeric zero, a nonzero number, text, or an invalid type. The string `"0"` does not satisfy numeric success.                                                                |
| `dialogPresent`, `actionPresent`, `messagePresent` | Presence of the corresponding response structure or a usable message, without uploading its content.                                                                                                        |
| `dialogKind`, `actionKind`                         | Fixed categories for the dialog and top-level action. Unknown values remain `other`.                                                                                                                        |

The older `dialog` field classifies `metrics.dialogId`; `dialog: "missing"` does not mean the response lacks a `dialog` object. Likewise, `responseType: "missing"` alone cannot distinguish an omitted document type from an empty or invalid value. Use the branch and shape fields together.

Non-200 responses may also contain a valid plist with useful error classifications. Those classifications are retained, but the operation still fails at `http_error`: a success-shaped body or familiar Apple error code cannot turn an HTTP failure into success or authorize a retry.

Already uploaded events cannot recover response fields that an older client omitted. An open tab also keeps its loaded JavaScript after a deployment. Reload the page before a post-deployment acceptance test, then verify that the browser events and bag/helper requests share one flow ID. Do not clear account storage merely to update the page.

### Regional purchase denials

`metrics.dialogId: MZCommerce.ContentBanned` is an explicit regional/content denial. The purchase interpreter reports `reason` and `purchaseBranch` as `region_unavailable`, displays localized guidance, and stops. It cannot become a successful or already-owned purchase, and it does not authorize the STDQ-to-GAME retry. HTTP 200 only describes the HTTP exchange.

Use these public facts to distinguish account-store selection from the server's network location:

| Field                   | Source and meaning                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogAppId`          | The public numeric App Store catalog ID actually passed to `buyProduct`. No search term, app name, account ID, or request body is logged.                                         |
| `storefrontId`          | At authentication, the selected public store ID; at purchase, the ID extracted from the exact outgoing storefront header. For example, `143465` is the China store.               |
| `assignedStorefrontId`  | A known public ID from Apple's `X-Set-Apple-Store-Front` response, if supplied.                                                                                                   |
| `requestedStorefrontId` | A known public ID from `X-Apple-Request-Store-Front`. This is a routing echo, not proof that the account's country changed.                                                       |
| `savedStorefrontId`     | The existing account's known public ID, logged at successful authentication only after the returned account matches the saved one. The account identifier itself is never logged. |
| `storefrontSource`      | `apple_assigned`, `saved_account`, `request_echo`, or `unset`, identifying how authentication selected its storefront.                                                            |

Both diagnostic validators accept only exact store IDs from the application's country map. Complete storefront headers, suffixes, unknown IDs, and arbitrary strings are excluded. The catalog ID must be a positive integer of at most ten decimal digits. These remain untrusted browser reports, not authorization evidence.

The license notification uses a per-operation snapshot of the actual store ID, including after account renewal. It must not render the pre-renewal account's country or read whichever account happens to be newest when a delayed failure arrives. An unavailable snapshot is shown as unknown. Search-country/entity changes also invalidate old results and in-flight lookups so old catalog metadata cannot be relabeled as belonging to a newly selected store.

Apple TLS terminates in the browser, but its TCP connection leaves through this deployment's Wisp container. The account store, the user's location, the Worker edge, and the container's network location are separate facts. Apple's [App Store privacy notice](https://www.apple.com/legal/privacy/data/zh-tw/app-store/) says it may use the connection IP to estimate location when determining availability of regionally restricted apps. Neither a public App Store listing nor `ContentBanned` alone identifies which condition caused a particular denial.

`wrangler.jsonc` constrains this deployment's container to `APAC`, retaining the existing application, Durable Object namespace, and `main` instance name. This avoids an unconstrained instance staying in North America after its initial request. Cloudflare's [regional placement constraint](https://developers.cloudflare.com/containers/concepts/placement/) does not promise a particular country, fixed egress IP, or Apple's geolocation result, and it does not guarantee that a regional denial will disappear.

After a placement deployment, verify both application `constraints.regions` and the active instance's `location.region` through `/containers/applications/{application_id}/instances-v2`. Build success, a Worker colo, and a rollout percentage do not prove the instance has moved. Check the new image/start time and helper health before the next user test. Container restarts interrupt active Wisp/provisioning/download work and do not preserve its ephemeral disk; completed account and device state remain in the browser. Never clear browser credentials or device state merely to change container placement.

## State audit and guards

| Path                    | States and transitions                                                                | Required guard / recovery                                                                                                                                                                            | Diagnostic stages                                             |
| ----------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Connection runtime      | Uninitialized → loading → ready; loading → failure/timeout                            | Share one in-flight load; release rejected initialization; bound initialization to 15 seconds; update Wisp configuration after site access-token renewal                                             | `transport`                                                   |
| Apple HTTP request      | Start → response or network/timeout failure                                           | Abort after 60 seconds; keep redirect handling in the owning protocol; never replay a purchase because transport delivery is uncertain                                                               | `apple_request`                                               |
| Bag lookup              | Proxy request → parsed bag or supported default route                                 | Record unavailable/malformed bag and fallback; never log the raw response/error                                                                                                                      | `bag`                                                         |
| SAP                     | Setup certificate → handshake → ready → sign exact request body                       | Signature setup/signing failure stops authentication; signer state stays in the browser                                                                                                              | `sap`                                                         |
| Native authentication   | Bootstrap/store proof → request → RP/SP, redirect, retry, 2FA, success, or failure    | RP/SP transitions are bounded; regenerate URL-bound proof and exact-body signature; bounded HTTP retry/backoff and redirect counts                                                                   | `authentication`, `proof`                                     |
| Two-factor continuation | Code required → retained session → code submitted → success/failure                   | Reuse the same session and flow only for the same credentials; discard continuation on account/device/view change                                                                                    | `verification`                                                |
| Storefront renewal      | Saved storefront → request echo or authoritative assignment                           | Preserve the saved storefront for the same DSID when Apple only echoes routing; only an explicit assignment overrides it                                                                             | `authentication`, `account_save`                              |
| Proof readiness         | Loading → ready, timeout, unavailable                                                 | Bounded readiness wait; classify helper HTTP/error code instead of recording opaque response data                                                                                                    | `bootstrap`, `proof`                                          |
| Provisioning            | Start → pending → browser finish → native finish → saved state                        | Pending handles expire, belong to a device and are consumed once; expired or failed finish never reports success                                                                                     | `provision_start`, `provision_finish`                         |
| Device state            | Load → serialize operation → native result → persist                                  | Per-device serialization; keep the previous saved state if native work or persistence fails                                                                                                          | `store_state`, `lock`                                         |
| Account action          | Idle → locked → refresh/read/write/action → released                                  | Same-account mutual exclusion across views; Web Locks coordinate supported browsers/tabs; read the latest account instead of overwriting it from old component props                                 | `lock`, `account_refresh`, `account_save`                     |
| License acquisition     | Refresh → save renewed account → purchase → save cookies                              | Refresh, 2FA and persistence failures stop the purchase; never silently use the old token after refresh failed; paid apps are rejected                                                               | `action`, `account_refresh`, `purchase`                       |
| Purchase response       | HTTP/dictionary validation → terms/dialog/error or explicit success                   | HTTP 200 plus `purchaseSuccess` and numeric zero status; preserve the documented 5002 already-owned case only for valid noncontradictory responses                                                   | `purchase`                                                    |
| Pricing fallback        | STDQ → recognized 2059 → GAME                                                         | At most one fallback; use newly returned cookies; dialogs/terms with the same numeric code are not fallback permission                                                                               | `purchase`                                                    |
| Version lookup          | Lookup → validate ID → selected version                                               | Reject zero, malformed and unsafe numeric IDs; pin the requested/latest version through download fallbacks                                                                                           | `version_lookup`                                              |
| Download discovery      | Entitlement → supported volume/redownload/update fallback or explicit failure         | Each endpoint gets its required fresh proof; explicit account/license/dialog/action/status failures never become success or fallback                                                                 | `download_product`, `kbsync`, `proof`                         |
| Enqueue                 | Discovered package → account state saved → backend request → task                     | Send once; timeout does not imply the server created nothing; refresh the task list before manual retry                                                                                              | `download_enqueue`                                            |
| Download execution      | Pending → downloading → injecting → completed/failed                                  | Per-task run ownership; stale cancelled generations cannot overwrite a resumed run or remove its controller/files                                                                                    | `task_state`, `download_fetch`, `ipa_compile`, `package_save` |
| Pause/resume/delete     | Active → paused → resumed; active/completed → deleted                                 | Serialize run cleanup; wait for cancelled chunk siblings before reuse; deleted runs cannot return as completed                                                                                       | `task_pause`, `task_resume`, `task_cancel`                    |
| Task list               | Poll → result → next poll; account/mutation revision changes                          | Single in-flight list request; discard stale revisions; coalesce identical task actions and block conflicting ones                                                                                   | `task_state`                                                  |
| Package update          | Check latest → enqueue replacement → replacement completes                            | Keep the old completed IPA until a replacement really exists; cancellation is checked again after asynchronous lookup                                                                                | `version_lookup`, `download_enqueue`                          |
| Import/clear accounts   | Pause new actions → drain active work → storage transaction/delete → resume           | Exclusive reset coordination; close cached IndexedDB connections; failed/stale writes cannot recreate a deleted account; blocked database deletion remains pending until the other connection closes | `clear_data`, `account_save`, `lock`                          |
| Diagnostic delivery     | Safe event → bounded local history → bounded upload queue → accepted/rejected/timeout | Logging must not change business results, retry purchases, or block UI; failed uploads remain available in bounded local history                                                                     | Separate from the business operation                          |

The `backend/tests`, `frontend/tests`, and `proof-helper` regression suites exercise these guards. This is a review of the paths and transitions in the current implementation, not a claim that every future Apple response or platform failure has been observed.

The connection wrapper releases failed initialization attempts, but a fatal abort inside the bundled native WebAssembly runtime may still require reloading the page. A successful wrapper retry cannot repair an already-aborted native instance.

Cross-tab account coordination requires Web Locks; browsers without that API retain the single-tab guard only. Cancelling a batch stops its later enqueues but cannot withdraw an already-sent request. Clearing multiple IndexedDB databases and localStorage is not one atomic transaction: a partial failure is reported as a failure, without claiming that every store was cleared.

## Data contract and credential boundary

- `frontend/src/utils/diagnostics.ts` constructs events from an explicit allowlist. Stage, outcome, reason, endpoint, mode, response type, dialog classifications, purchase branches, and response-shape categories are enumerated. Error codes are bounded numeric codes or known helper codes.
- `dialogCode` accepts only `MZCommerce`, `MZFinance`, or `MZCommerceInAppBuy` followed by bounded, dot-separated ASCII identifier segments, with a 160-character total limit. Both client and server validate the complete value. URL, email, whitespace, control characters, and arbitrary response/message fields are not accepted as dialog codes. A syntactically valid code is still an unverified client report and does not establish its business meaning.
- Storefront fields accept only known public catalog store IDs; `storefrontSource` is enumerated and `catalogAppId` is a bounded positive integer. Only these selected public facts are extracted from the account/request context. No complete header or account object is attached to an error or sent to the diagnostic endpoint.
- `POST /api/diagnostics` validates the same schema before writing a JSON line. It rejects unknown fields, oversized/invalid JSON, and cross-site browser requests, and uses the existing site access check. The route's 4 KiB parser runs before the application's large package-metadata parser.
- The receiver has a bounded token bucket: burst 240, refill 4 events/second, at most 1,024 client buckets, and a 10-minute idle expiry. A shared proxy address can share a bucket. Rate limiting affects diagnostic delivery, not account operations.
- Frontend transport has at most two concurrent uploads, a 200-event queue, and a five-second upload deadline. It does not retry business operations. Local history retains the latest 200 events and remains exportable if logging is unavailable. These are bounded diagnostics, not a durable offline event queue.
- Server/helper logs add request/task identifiers where relevant. New server IDs are generated independently; caller-provided flow IDs must be UUIDs. Account identifiers, account hashes and device GUIDs are not needed in diagnostic events.
- Never record passwords, verification codes, cookies, tokens, DSIDs, exact login/purchase bodies, opaque machine state, provisioning handles/challenges, proof/header values, arbitrary URLs, `Error.message`, or native error details. Do not spread request/response/error objects into a logger.
- Apple TLS still terminates in the browser. Only the safe classification of the response is sent to the diagnostic endpoint. No account credential moves to the backend.
- `wrangler.jsonc` keeps invocation logging enabled and sets `observability.redact_query_string: true`. The Wisp adapter removes the query before handing the request to library logging, after retaining the information needed for the access check.

## Interpreting common failures

| Diagnostic                                        | Meaning / next check                                                                                                                                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentication`, HTTP 204, `retry_exhausted`     | Native Apple authentication still returned empty/transient responses after its bounded retry. Inspect preceding RP/SP/proof transitions.                                                                                                      |
| `verification_required`                           | Continue on the account screen with a fresh verification code; acquiring a license must not bypass this state.                                                                                                                                |
| `terms_required`                                  | Open the App Store with the same Apple account, review the terms, then retry. The application does not automatically accept legal terms.                                                                                                      |
| `MZCommerce.ContentBanned` / `region_unavailable` | Apple denied regional/content availability. Check the actual purchase `storefrontId`, `catalogAppId`, active container placement, and availability with the same account in the official App Store. Do not automatically replay the purchase. |
| `errorCode: 1008` / `device_verification`         | Apple did not accept device verification. Re-authenticate; inspect the proof/provisioning phases.                                                                                                                                             |
| `2034` / `2042` / `token_expired`                 | Account credentials require renewal.                                                                                                                                                                                                          |
| `PROVISIONING_EXPIRED`                            | The pending native context expired or was already consumed. Start a new sign-in; do not replay the finish.                                                                                                                                    |
| `storage`                                         | Browser state could not be read/saved, or backend task persistence failed. Identify the stage/source before retrying.                                                                                                                         |
| `lock` + `busy`                                   | An overlapping action/reset was blocked rather than allowed to race.                                                                                                                                                                          |
| `download_enqueue` failure/timeout                | Check the downloaded-task list: a lost response does not prove enqueue failed on the server. There is no cross-restart exactly-once enqueue guarantee.                                                                                        |
| Wisp `reason 2`                                   | Voluntary stream closure; it is not an Apple HTTP error code.                                                                                                                                                                                 |

## Verification commands

Workers Builds success means that the Worker deployment and container rollout were submitted. Before calling a release complete, compare the live container image with the image built for that commit, send a safe diagnostic event, and query its `flowId` in the Containers dataset. Include `/api/store-proof/health` in the same flow to verify the browser, backend, and helper correlation headers. A Worker version at 100% traffic alone does not prove the container already runs the new image. See [Cloudflare's rollout lifecycle](https://developers.cloudflare.com/containers/configuration/rollouts/).

```bash
npm --prefix frontend test
npm --prefix frontend run build
./frontend/node_modules/.bin/tsc --noEmit --project frontend/tsconfig.json
npm --prefix backend test
npm --prefix backend run build
npm run format:check
```

Run the Go helper tests inside the pinned upstream module as described in `proof-helper/README.md`. Native/helper synthetic tests do not establish that a real Apple account completed sign-in or received a license; that final acceptance must come from the user's browser and its correlated diagnostics.

## Primary protocol references

- [Pinned ipatool purchase handling](https://github.com/majd/ipatool/blob/3b02b4c55576562f2a55284cda9db9a4411d3067/pkg/appstore/appstore_purchase.go)
- [Terms response fixture without failureType](https://github.com/majd/ipatool/blob/3b02b4c55576562f2a55284cda9db9a4411d3067/pkg/appstore/appstore_terms_test.go)
- [Storefront assignment versus request echo](https://github.com/majd/ipatool/blob/3b02b4c55576562f2a55284cda9db9a4411d3067/pkg/appstore/account_storefront.go)
- [Cloudflare structured Workers logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
