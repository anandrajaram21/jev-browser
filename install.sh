#!/bin/sh
# Install jev-browser from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/anandrajaram21/jev-browser/main/install.sh | sh
#
# JEV_BROWSER_VERSION      release to install, e.g. v0.1.0 (default: latest)
# JEV_BROWSER_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
set -eu

REPO="anandrajaram21/jev-browser"
VERSION="${JEV_BROWSER_VERSION:-latest}"
INSTALL_DIR="${JEV_BROWSER_INSTALL_DIR:-$HOME/.local/bin}"

fail() { echo "jev-browser install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s); on Windows download jev-browser-windows-x64.exe from https://github.com/$REPO/releases" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac
# An x86 shell under Rosetta still gets the native Apple silicon binary.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then arch=arm64; fi

asset="jev-browser-$os-$arch"
case "$VERSION" in
  latest) base="https://github.com/$REPO/releases/latest/download" ;;
  v*) base="https://github.com/$REPO/releases/download/$VERSION" ;;
  *) base="https://github.com/$REPO/releases/download/v$VERSION" ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset ($VERSION)..."
curl -fSL --progress-bar "$base/$asset" -o "$tmp/$asset" || fail "download failed: $base/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
else actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "checksum mismatch for $asset"

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/jev-browser"
echo "Installed $INSTALL_DIR/jev-browser ($("$INSTALL_DIR/jev-browser" --version))"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo; echo "$INSTALL_DIR is not on your PATH. Add it, e.g.:  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

echo
echo "Next:"
if ! command -v agent-browser >/dev/null 2>&1; then
  echo "  npm i -g agent-browser && agent-browser install   # the browser jev-browser drives (or: brew install agent-browser)"
fi
echo "  jev-browser setup           # save your TypeSafe and OpenRouter API keys"
echo "  jev-browser install-skill   # teach Claude Code, Codex, Cursor... to use it"
echo "  jev-browser doctor          # check everything works"
