#!/bin/sh
set -eu

# Official Lean release artifacts, pinned by version and GitHub release digest.
# This runs only in a build stage; no compiler is copied into the application image.
asspp_lean_version=4.36.0
asspp_lean_destination=${1:?Usage: install-lean.sh /absolute/install/path}
case "$(uname -m)" in
  x86_64)
    asspp_lean_platform=linux
    asspp_lean_sha256=2b7ab1ed8b92d2e6abfaf41344823b510064dbc9c0260cac73eb496ab2dea6eb
    ;;
  aarch64|arm64)
    asspp_lean_platform=linux_aarch64
    asspp_lean_sha256=35471998152191ef809418ce5bf61f8fc5f209e5e3be05b48bdc4949fdb3e726
    ;;
  *) echo 'Unsupported Lean build architecture' >&2; exit 1 ;;
esac
asspp_lean_temporary=$(mktemp -d)
trap 'rm -rf "$asspp_lean_temporary"' EXIT HUP INT TERM
asspp_lean_archive="$asspp_lean_temporary/lean.tar.zst"
curl --fail --location --retry 3 --connect-timeout 30 --max-time 900 \
  "https://releases.lean-lang.org/lean4/v$asspp_lean_version/lean-$asspp_lean_version-$asspp_lean_platform.tar.zst" \
  --output "$asspp_lean_archive"
printf '%s  %s\n' "$asspp_lean_sha256" "$asspp_lean_archive" | sha256sum --check --status
mkdir -p "$asspp_lean_destination"
tar --zstd -xf "$asspp_lean_archive" --strip-components=1 -C "$asspp_lean_destination"
"$asspp_lean_destination/bin/lean" --version
