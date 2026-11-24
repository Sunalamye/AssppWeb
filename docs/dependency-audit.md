# Deployment ownership and external dependencies

Reviewed on 2026-11-24 against the application at `1e774fc408fab10b2433b00fb998ebc75157b666` and the source-build deployment changes accompanying this document.

## Upstream archive and this fork

GitHub identifies `Lakr233/AssppWeb` as the parent and source of `Sunalamye/AssppWeb`. The original repository was archived on 2026-11-18; this fork is not archived. Archiving makes the upstream repository read-only and signals that it is no longer actively maintained. It does not establish that an existing image or downloadable file has already been removed.

The deployed Cloudflare application builds this fork's root `Dockerfile`. Its frontend, Node backend, and native proof helper run from an image in the deployment owner's Cloudflare registry. The original author's AssppWeb image is not part of that build.

## Deployment entry points corrected in this fork

| Entry point                | Previous dependency                                                       | Current behavior                                                                                                |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Default `compose.yml`      | Original author's `ghcr.io/lakr233/assppweb:latest`                       | Build the current checkout's `Dockerfile` as `assppweb:local`; `pull_policy: build` selects source construction |
| README manual Docker setup | Download the original author's Compose file from its moving `main` branch | Clone `Sunalamye/AssppWeb`, then run `docker compose up --build -d`                                             |
| README Railway setup       | Deploy and automatically update the original author's GHCR image          | Connect this fork's GitHub branch and build its root Dockerfile                                                 |
| Cloudflare Workers Builds  | Already connected to this fork and `./Dockerfile`                         | Continue using that source build and verify the actual container image after rollout                            |

This does not claim that a public `ghcr.io/sunalamye/assppweb` package exists. The optional GitHub Actions image workflow uses `github.repository` rather than a hardcoded author namespace, but Cloudflare deployment does not require enabling that workflow.

## Runtime dependency inventory

| Component                                                        | Source and ownership                                                                        | Availability boundary                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Frontend application, icons, manifest                            | Files in this fork, served by its own container                                             | No original-author frontend host or asset CDN                                                             |
| Wisp relay                                                       | `frontend/src/apple/libcurl-init.ts` uses the current `location.host` and `/wisp/`          | Runs on this deployment's backend                                                                         |
| libcurl WebAssembly                                              | `libcurl.js/bundled`, locked to `0.7.4` in the npm lockfile                                 | WASM is embedded in the bundled package and included in the Vite output; no runtime CDN URL is configured |
| SAP implementation and tables                                    | Vendored TypeScript and `tables.json` under `frontend/src/apple/sap/`                       | ApplePackage links record source provenance; login does not download code from that repository            |
| Native proof HTTP service                                        | `http://127.0.0.1:8081` inside this container                                               | No external author-operated proof/signing service                                                         |
| Account authentication, SAP handshake, provisioning and commerce | Apple service endpoints selected by the checked protocol and bag                            | Apple availability and protocol changes remain operational dependencies                                   |
| App search, latest versions and historical metadata              | Apple iTunes/commerce endpoints in `backend/src/routes/search.ts` and `frontend/src/apple/` | No original-author version-history API was found                                                          |
| Account/device state                                             | Browser IndexedDB; account operations remain browser-side                                   | No original-author account database                                                                       |

The audit found no application-code request to a Lakr233 personal domain or CDN. GitHub attribution links, license notices, npm package funding metadata, and the intentionally invalid preview-fixture domain are not runtime downloads.

## Rebuild dependencies that remain

Source builds still need third-party software and public assets. These belong to the relevant upstream projects or Apple, rather than to the archived AssppWeb author's deployment.

| Dependency                                       | Pin or integrity check                                                                                           | When it is needed                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `majd/ipatool`                                   | Docker checks out and verifies commit `3b02b4c55576562f2a55284cda9db9a4411d3067`                                 | Building the Go proof helper                                      |
| Apple native runtime frameworks                  | Fixed IPSW URL on `updates.cdn-apple.com`; expected file sizes and SHA-256 hashes in the pinned asset manifest   | Preparing a new image when its native asset cache is absent       |
| Unicorn native library                           | Fixed `2.1.4` Linux amd64/arm64 wheels on `files.pythonhosted.org`; archive and extracted-library SHA-256 checks | Preparing the native emulator                                     |
| Store profile                                    | Embedded by the pinned Go source                                                                                 | Compiled into the helper; not fetched as a runtime GitHub release |
| JavaScript packages                              | Root/frontend/backend lockfiles resolve npm artifacts from `registry.npmjs.org`                                  | Installing build dependencies                                     |
| Go modules, Node/Go base images, Debian packages | Existing Go/module and Docker build definitions                                                                  | Building a new image                                              |
| Cloudflare deployment tooling                    | `@cloudflare/containers@0.1.0`; Workers Builds currently invokes `npx wrangler deploy`                           | Building and deploying on the owner's Cloudflare account          |

Docker runs the helper's `--prepare` during construction and copies `/opt/asspp-cache` into the final image. Normal startup uses that verified cache. A future clean rebuild can still fail if an upstream source, package registry, Apple IPSW, or emulator archive becomes unavailable. A fixed URL or Git commit prevents unreviewed version drift; it does not guarantee permanent hosting.

Apple account operations still require Apple services, including `auth.itunes.apple.com`, Apple bag/pod commerce hosts, `gsa.apple.com`, and Apple's certificate service. Keeping the code and image under this fork's control cannot remove that protocol dependency.

## Maintenance priorities

1. Keep deploying this fork's source and preserve the tested image digest with the corresponding commit and lockfiles.
2. Retain the already-vendored SAP implementation, tables, provenance and license notices. Removing attribution would not improve availability.
3. If stronger disaster recovery is required, preserve the pinned ipatool source and the verified runtime artifacts used by a tested image. Record checksums so restored artifacts receive the same verification.
4. Review and pin deployment tooling and base-image digests during planned maintenance. Do not silently track a new protocol-engine revision while troubleshooting authentication.
5. Verify production by its live container image and a correlated diagnostic request, as described in `observability.md`; Worker deployment success alone does not prove container replacement has finished.

No author-controlled API has been replaced with an unverified public mirror, and no new public registry package is assumed.

## Primary references

- [Archived original repository](https://github.com/Lakr233/AssppWeb)
- [GitHub repository archival behavior](https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories)
- [Docker Compose build and image behavior](https://docs.docker.com/reference/compose-file/build/)
- [Railway Dockerfile builds](https://docs.railway.com/builds/dockerfiles)
- [Pinned Apple asset manifest and cache loader](https://github.com/majd/ipatool/blob/3b02b4c55576562f2a55284cda9db9a4411d3067/internal/sap/assets/assets.go)
- [Pinned Unicorn artifact manifest](https://github.com/majd/ipatool/blob/3b02b4c55576562f2a55284cda9db9a4411d3067/internal/sap/unicorn/artifact.go)
- [Embedded Store profile](https://github.com/majd/ipatool/blob/3b02b4c55576562f2a55284cda9db9a4411d3067/internal/store/profile/profile.go)
- [Cloudflare container rollout lifecycle](https://developers.cloudflare.com/containers/configuration/rollouts/)
