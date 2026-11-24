# Local device-proof helper

This helper runs **inside the application's Linux container**, bound to
`127.0.0.1:8081`. The application exposes its small JSON interface through the
existing access-key check. It is not a standalone public login service.

It adapts the device-proof implementations from
[`majd/ipatool`](https://github.com/majd/ipatool), pinned to
`3b02b4c55576562f2a55284cda9db9a4411d3067`. That revision includes the native
authentication and download changes following v2.8.1. The upstream MIT license
is preserved in `LICENSE.ipatool` and must accompany the helper binary.

## Trust boundary

The browser continues to handle Apple ID, password, verification code, account
cookies, account tokens, the exact login/download body, and SAP signing. None
of those are valid fields in this API. Unknown fields, duplicate JSON keys,
unexpected per-operation fields, invalid endpoints, and oversized input are
rejected before the native runtime is called.

This process handles the browser's six-byte device identifier, software machine
identity/provisioning state, Apple device-provisioning challenges and responses,
and a numeric DSID when producing download key-synchronization data. These are
device proof materials; treat their opaque values as sensitive. Neither request
bodies nor native error details are logged. Responses are marked `no-store`.

Completed device state is returned as an opaque base64 JSON envelope and stored
by the browser. It is bound to that browser's canonical device ID. The helper
does not persist that state on server disk or keep a shared GUID-to-state map.
Only unfinished provisioning sessions remain in memory: at most two sessions,
for at most two minutes each, with cryptographically random, single-use handles.
Container restarts discard unfinished sessions; a browser can start again.

The browser itself posts to Apple's fixed
`https://auth.itunes.apple.com/auth/v1/otp/1.5/finish` endpoint through the existing
Wisp transport, retaining its Apple cookies. The helper never performs that
account-associated request. General machine bootstrap uses the upstream fixed
`gsa.apple.com` endpoints with an HTTP client that has no account cookie jar.

## HTTP contract

`GET /health` returns `{ "status": "loading" | "ready" | "error",
"sourceRevision": "..." }`. Only `ready` uses HTTP 200; the others use 503.

`POST /v1/proof` requires `Content-Type: application/json`. Maximum body size is
4 MiB. Every field is a nonempty string; unlisted fields are rejected. Device IDs
are exactly twelve hexadecimal characters, accepted in either case and stored
in uppercase. All base64 blobs use standard padded base64 without whitespace.

| Operation          | Request fields in addition to `operation`, `deviceId`       | Successful response                                  |
| ------------------ | ----------------------------------------------------------- | ---------------------------------------------------- |
| `bootstrap`        | `endpoint`, optional `state`                                | `state`, `headers`, `mode` (`store` or `bootstrap`)  |
| `proof`            | `endpoint`, `state`                                         | `state`, `headers`                                   |
| `provision-start`  | `state`, `challenge`                                        | `pending`, `clientData`, `kbsync`, `identityHeaders` |
| `provision-finish` | `pending`, `settingInfo`, `transportKey`, optional `keybag` | `state`                                              |
| `kbsync`           | `dsid` (positive decimal uint64)                            | `kbsync`                                             |

`bootstrap` first tries a Store AMD proof using existing state. If that fails, it
performs general machine provisioning while preserving the machine identifier.
General `X-Apple-I-MD` and `X-Apple-I-MD-M` headers are returned under the native
authentication names `X-Apple-AMD` and `X-Apple-AMD-M`; other approved identity and
routing headers remain intact. `provision-start.identityHeaders` contains only
identity fields, excluding proof and routing headers, as required for the Apple
finish request. A regular `proof` returns the Store AMD pair.

State is opaque and versioned. Do not decode or modify it in browser code. Save
the updated state after every successful response and serialize operations per
device, including across browser tabs. A provisioning handle is consumed after
one valid finish attempt, including a failed native completion.

Allowed proof endpoints are HTTPS on port 443 without URL credentials,
fragments, encoded paths, or arbitrary query parameters:

- `auth.itunes.apple.com/auth/v1/native`, optionally `/fast` and a final slash;
- `buy.itunes.apple.com` or `p<digits>-buy.itunes.apple.com` at
  `/WebObjects/MZFinance.woa/wa/authenticate`, optionally a final slash;
- the same buy hosts at
  `/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct`;
- `downloaddispatch.itunes.apple.com` at `/r/redownload`, `/up/updateProduct`, or
  `/WebObjects/DownloadDispatch.woa/wa/ent/download`.

Authentication paths accept no query or one matching `guid`. Commerce paths
require exactly one matching `guid`. GUID comparison ignores hexadecimal letter
case; the exact endpoint string is passed unchanged to the native proof encoder.
`bootstrap` accepts only authentication paths. Explicit port suffixes, including
`:443`, are rejected so the URL representation stays unambiguous.

Errors have the shape `{ "error": { "code": "...", "message": "..." } }`.
Relevant codes include `INVALID_REQUEST` (400), `REQUEST_TOO_LARGE` (413),
`NOT_PROVISIONED` (409), `PROVISIONING_EXPIRED` (410), `PROVISIONING_BUSY` (429),
`HELPER_UNAVAILABLE` (503), `PROOF_FAILED` (502), and `PROOF_TIMEOUT` (504).
Native jobs are serialized and have a 90-second request budget. A retained
provisioning VM has an independent two-minute lifetime so it survives completion
of the start HTTP request. Expired runtimes are cancelled and closed.

The helper emits structured `asspp.diagnostic` events with `source: "helper"`.
Only validated UUID correlation headers (`X-Asspp-Flow-Id` and the backend's
`X-Asspp-Request-Id`), fixed stage/outcome categories, timing, and safe numeric
HTTP status are included. Queue waits, bootstrap fallback, pending expiry, and
completion are observable. Request bodies, device identifiers, DSIDs, proof
headers, pending handles, and native error text are never logged. A recognized
upstream machine-provisioning HTTP error contributes only its three-digit status.
Native results returned after cancellation or provisioning expiry cannot become
successful API responses.

## Build and cache preparation

The Docker build clones the pinned upstream revision, copies this directory to
its `tools/asspp-proof` directory, and runs:

```sh
go build -trimpath -o /out/asspp-proof ./tools/asspp-proof
/out/asspp-proof --prepare
```

Build inside the upstream Go module because the adapter deliberately uses its
`internal` APIs. The pinned source requires Go 1.26.5. Keep the upstream module's
`go.mod` and `go.sum`; this directory intentionally has no separate module file.
The runtime base and build environment must use a compatible Linux libc/CPU
architecture. This helper does not run inside the JavaScript Workers isolate.

`--prepare` loads the official pinned Apple assets and verifies that both the ADI
and AppleMediaServices emulators open and close. It never sends Apple account
credentials or performs an account login. Upstream verifies public asset hashes
and manages the pinned Unicorn native library. Bake the resulting user cache
into the image, and use that same cache location at runtime. Initial preparation
can take several minutes; a cached startup is substantially faster. The daemon
also performs this preparation before reporting `ready`.

## Verification

The production HTTP service, request validation, diagnostic boundary and
provisioning policy can also be tested without fetching native dependencies:

```sh
npm run test:helper
```

This uses Go's race detector with a mock only at the `proofRuntime` interface.
The native implementation remains in `runtime.go`; the dependency-free
interfaces are in `contracts.go`. `npm run verify:formal` additionally compares
all 16 provisioning-policy inputs against the freshly checked Lean model and
requires an actual passing Go comparison test, not a skipped or missing test.
Native finish must pass the handle/device/expiry/context gate, consume the
handle once, and recheck cancellation/expiry before publishing state.

Run these inside the pinned upstream checkout after copying this directory:

```sh
go test -race ./tools/asspp-proof
go build -trimpath -o /tmp/asspp-proof ./tools/asspp-proof
/tmp/asspp-proof --prepare
```

The mocked tests check the credential boundary, strict JSON parsing, URL/GUID
binding, bootstrap header conversion, client-owned state, provisioning lifetime
and replay prevention, pending capacity/expiry, response sanitization, body size
limits, and cancellation while waiting for serialized native jobs. The prepare
smoke checks real native assets without an Apple account. These checks cannot
prove that Apple will accept an actual account login; that final verification
must occur in the user's browser.
