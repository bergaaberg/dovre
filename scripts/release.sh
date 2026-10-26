#!/bin/sh
# Builds `dovre` (the launcher, with `dovre bridge`) for the six targets customers install from
# (dovre-site#9), and with --upload puts them where dovre.dev/dl serves them.
#
#   sh scripts/release.sh 0.1.0            build into dist/release/0.1.0/
#   sh scripts/release.sh --upload 0.1.0   build, then upload to R2 and point dovre.dev/dl/latest at it
#
# Each archive (dovre-<os>-<arch>.tar.gz, .zip on Windows) holds the binary and the bridge's bundle
# beside it, where findBundle (launcher/bridge.go) looks:
#   dovre            dovre.exe and dovrew.exe (no console window) on Windows
#   bridge/main.mjs  bridge/spawn-worker.mjs   (pnpm build:bridge)
# Node isn't in it: the bridge fetches its pinned Node on first run (launcher/node.go).
# SHA256SUMS lists every archive; install.sh and install.ps1 check against it.
#
# macOS signing (optional): DOVRE_SIGN_IDENTITY="Developer ID Application: …" signs both darwin
# binaries with the hardened runtime, and DOVRE_NOTARY_PROFILE (a `xcrun notarytool
# store-credentials` profile) has Apple notarise them too.
#
# Upload: R2 bucket $DOVRE_RELEASE_BUCKET (default dovre-releases) as <version>/<file>, then the
# object `latest` (the version) last, so installers never see a version that's half there.
set -eu

upload=0
if [ "${1:-}" = "--upload" ]; then upload=1; shift; fi
v="${1:-}"
case "$v" in
  '' | *[!0-9A-Za-z.+-]* | .*) echo "usage: sh scripts/release.sh [--upload] <version>  (e.g. 0.1.0)" >&2; exit 2 ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
if [ "$upload" = 1 ] && [ -n "$(git status --porcelain)" ]; then
  echo "release: the tree has changes; commit them first, so the release is a commit" >&2
  exit 1
fi
commit=$(git rev-parse --short HEAD)
out="dist/release/$v"
rm -rf "$out"
mkdir -p "$out/stage"

pnpm -s build:bridge

for t in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64 windows/arm64 windows/amd64; do
  goos=${t%/*}
  goarch=${t#*/}
  arch=$goarch
  [ "$arch" = amd64 ] && arch=x64
  name="dovre-$goos-$arch"
  dir="$out/stage/$name"
  mkdir -p "$dir/bridge"
  cp dist/bridge/main.mjs dist/bridge/spawn-worker.mjs "$dir/bridge/"
  flags="-s -w -X main.version=$v"
  if [ "$goos" = windows ]; then
    GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 go -C launcher build -trimpath -ldflags "$flags" -o "$root/$dir/dovre.exe" .
    GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 go -C launcher build -trimpath -ldflags "$flags -H=windowsgui" -o "$root/$dir/dovrew.exe" .
    (cd "$dir" && zip -qrX "$root/$out/$name.zip" dovre.exe dovrew.exe bridge)
  else
    GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 go -C launcher build -trimpath -ldflags "$flags" -o "$root/$dir/dovre" .
    if [ "$goos" = darwin ] && [ -n "${DOVRE_SIGN_IDENTITY:-}" ]; then
      codesign --force --options runtime --timestamp --sign "$DOVRE_SIGN_IDENTITY" "$dir/dovre"
      if [ -n "${DOVRE_NOTARY_PROFILE:-}" ]; then
        (cd "$dir" && zip -qX notarise.zip dovre)
        xcrun notarytool submit "$dir/notarise.zip" --keychain-profile "$DOVRE_NOTARY_PROFILE" --wait
        rm "$dir/notarise.zip"
      fi
    fi
    COPYFILE_DISABLE=1 tar -C "$dir" --uid 0 --gid 0 --uname root --gname root -czf "$out/$name.tar.gz" dovre bridge
  fi
done
rm -rf "$out/stage"
(cd "$out" && shasum -a 256 *.tar.gz *.zip > SHA256SUMS)
echo "$v ($commit) in $out:"
cat "$out/SHA256SUMS"

[ "$upload" = 1 ] || exit 0
bucket="${DOVRE_RELEASE_BUCKET:-dovre-releases}"
wrangler="${WRANGLER:-npx --yes wrangler@4}"
for f in "$out"/*.tar.gz "$out"/*.zip "$out/SHA256SUMS"; do
  case "$f" in
    *.tar.gz) type=application/gzip ;;
    *.zip) type=application/zip ;;
    *) type="text/plain; charset=utf-8" ;;
  esac
  $wrangler r2 object put "$bucket/$v/$(basename "$f")" --file "$f" --content-type "$type" --remote
done
printf '%s\n' "$v" > "$out/latest"
$wrangler r2 object put "$bucket/latest" --file "$out/latest" --content-type "text/plain; charset=utf-8" --remote
echo "dovre.dev/dl/latest is $v"
