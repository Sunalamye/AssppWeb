# Cloudflare Deploy (Workers + Containers)

This folder contains the Worker source used by the root `wrangler.jsonc`.

## Why Containers

AssppWeb backend needs:

- WebSocket upgrades (`/wisp/`)
- filesystem writes for compiled IPA output
- long-running Node.js runtime behavior
- a native device-proof helper and its verified Apple runtime assets

Cloudflare Containers builds the root `Dockerfile`. The Worker remains a router; native code runs in the container, not in the JavaScript Workers isolate. The container supervisor starts the Node.js application and the loopback-only device-proof helper together and stops the container if either process exits.

## Deploy

If Workers Builds already watches this repository's `main` branch, commit and push to `main` to use that existing deployment pipeline. The native authentication update needs no additional Cloudflare binding, secret, or account resource. An uncached Docker build also downloads and verifies the public native assets; subsequent builds can reuse their cache.

For manual deployment:

```bash
npx wrangler login
npx wrangler deploy
```

For local preview on Cloudflare runtime:

```bash
npx wrangler dev
```

## Notes

- Deploy configuration lives in the repository root `wrangler.jsonc`.
- `cloudflare/src/index.ts` imports `@cloudflare/containers`.
- Root `wrangler.jsonc` runs a build command to install `@cloudflare/containers` automatically before deploy, so CI can still run plain `npx wrangler deploy`.
- The worker routes all HTTP and WebSocket traffic to one named container instance (`main`) to keep app state consistent.
- Container filesystem is ephemeral. Compiled packages may be lost when the container stops and restarts.
- Completed device provisioning state stays in the browser's IndexedDB and is restored on each proof request. Only unfinished provisioning contexts remain in helper memory, with a two-minute expiration.
- Apple account credentials and account cookies remain in the browser/Wisp path. The helper sees only the device-proof fields documented in [proof-helper/README.md](../proof-helper/README.md).
- `/api/settings` reports `appleAuthProtocol: "native-store-amd-v1"` for the new protocol. `/api/store-proof/health` returns HTTP 200 with `status: "ready"` once the helper is ready, or HTTP 503 while it is loading. The frontend waits through cold starts before requesting proofs.

## Troubleshooting

If deploy logs fail after upload with:

```text
Deploy a container application
Unauthorized
```

the account/token used by CI is missing required permissions for Containers APIs.

Required account token permissions:

- `Workers Scripts Edit`
- `Containers Edit`
- `Cloudchamber Edit`

Also ensure the account is on a Workers Paid plan, since Containers are not available on Free.
