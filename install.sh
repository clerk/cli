#!/usr/bin/env bash
# Install script for the Clerk CLI.
# Downloads a pre-compiled binary from GitHub Releases, or installs from local build artifacts.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/clerk/cli/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/clerk/cli/main/install.sh | bash -s -- --canary
#   curl -fsSL https://raw.githubusercontent.com/clerk/cli/main/install.sh | bash -s -- --version v0.1.0-canary.v20260313145959
#   ./install.sh --local                          # install from dist/artifacts/
#   ./install.sh --local --artifacts-dir ./build   # install from custom path
#
# Environment variables:
#   CLERK_INSTALL_DIR  — directory to install to (default: /usr/local/bin, or ~/.local/bin if not writable)

set -euo pipefail

REPO="clerk/cli"
BINARY_NAME="clerk"
INSTALL_DIR="${CLERK_INSTALL_DIR:-}"
CHANNEL=""
VERSION=""
LOCAL=false
ARTIFACTS_DIR=""

# ─── Parse arguments ───────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --canary)
      CHANNEL="canary"
      shift
      ;;
    --version)
      if [ $# -lt 2 ] || [[ "$2" == -* ]]; then
        echo "Error: --version requires a value (e.g. --version v0.1.0)" >&2
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    --install-dir)
      if [ $# -lt 2 ] || [[ "$2" == -* ]]; then
        echo "Error: --install-dir requires a value (e.g. --install-dir /usr/local/bin)" >&2
        exit 1
      fi
      INSTALL_DIR="$2"
      shift 2
      ;;
    --install-dir=*)
      INSTALL_DIR="${1#--install-dir=}"
      shift
      ;;
    --local)
      LOCAL=true
      shift
      ;;
    --artifacts-dir)
      if [ $# -lt 2 ] || [[ "$2" == -* ]]; then
        echo "Error: --artifacts-dir requires a value (e.g. --artifacts-dir ./build)" >&2
        exit 1
      fi
      ARTIFACTS_DIR="$2"
      LOCAL=true
      shift 2
      ;;
    --artifacts-dir=*)
      ARTIFACTS_DIR="${1#--artifacts-dir=}"
      LOCAL=true
      shift
      ;;
    --help|-h)
      echo "Install the Clerk CLI"
      echo ""
      echo "Usage:"
      echo "  install.sh [options]"
      echo ""
      echo "Options:"
      echo "  --canary                Install the latest canary release"
      echo "  --version <tag>         Install a specific version (e.g. v0.1.0)"
      echo "  --install-dir <path>    Directory to install to"
      echo "  --local                 Install from local build artifacts (dist/artifacts/)"
      echo "  --artifacts-dir <path>  Path to local artifacts directory (implies --local)"
      echo "  -h, --help              Show this help"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# ─── Detect platform ──────────────────────────────────────────────────────────

detect_target() {
  local os arch libc=""

  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="win32" ;;
    *)
      echo "Error: unsupported operating system: $(uname -s)" >&2
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "Error: unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac

  # Detect musl on Linux
  if [ "$os" = "linux" ]; then
    if ldd --version 2>&1 | grep -qi musl; then
      libc="-musl"
    elif command -v ldd >/dev/null 2>&1; then
      libc=""  # glibc
    elif [ -f /etc/alpine-release ]; then
      libc="-musl"
    fi

    # The musl binary dynamically links libstdc++ and libgcc_s (Bun embeds
    # JavaScriptCore which is C++).  These are not shipped by default on
    # Alpine and other minimal musl distros.
    if [ "$libc" = "-musl" ]; then
      local missing=""
      if ! ldconfig -p 2>/dev/null | grep -q libstdc++ && ! [ -f /usr/lib/libstdc++.so.6 ]; then
        missing="libstdc++"
      fi
      if ! ldconfig -p 2>/dev/null | grep -q libgcc_s && ! [ -f /usr/lib/libgcc_s.so.1 ]; then
        missing="${missing:+$missing, }libgcc"
      fi
      if [ -n "$missing" ]; then
        echo "Error: missing required shared libraries: ${missing}" >&2
        echo "" >&2
        echo "The Clerk CLI binary requires libstdc++ and libgcc to run." >&2
        if [ -f /etc/alpine-release ]; then
          echo "Install them with:  apk add libstdc++ libgcc" >&2
        else
          echo "Install the libstdc++ and libgcc packages for your distribution." >&2
        fi
        exit 1
      fi
    fi
  fi

  echo "${os}-${arch}${libc}"
}

TARGET="$(detect_target)"
EXT=""
if [[ "$TARGET" == win32-* ]]; then
  EXT=".exe"
fi

echo "Detected platform: ${TARGET}"

# ─── Resolve source ───────────────────────────────────────────────────────────

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [ "$LOCAL" = true ]; then
  # ─── Local artifacts ─────────────────────────────────────────────────────────
  if [ -z "$ARTIFACTS_DIR" ]; then
    ARTIFACTS_DIR="dist/artifacts"
  fi

  LOCAL_BINARY="${ARTIFACTS_DIR}/${TARGET}/${BINARY_NAME}${EXT}"
  if [ ! -f "$LOCAL_BINARY" ]; then
    echo "Error: no binary found at ${LOCAL_BINARY}" >&2
    echo "Run 'bun run build:compile:all' or 'bun run scripts/build.ts --target=${TARGET}' first." >&2
    exit 1
  fi

  cp "$LOCAL_BINARY" "${TMPDIR}/${BINARY_NAME}${EXT}"
  chmod +x "${TMPDIR}/${BINARY_NAME}${EXT}"

  # Read version from the binary itself
  TAG=$("${TMPDIR}/${BINARY_NAME}${EXT}" --version 2>/dev/null || echo "local")
  echo "Installing Clerk CLI ${TAG} from local artifacts..."
else
  # ─── GitHub Releases ─────────────────────────────────────────────────────────
  if [ -n "$VERSION" ]; then
    TAG="$VERSION"
    if [[ "$TAG" != v* ]]; then
      TAG="v${TAG}"
    fi
  elif [ "$CHANNEL" = "canary" ]; then
    TAG=$(gh release list --repo "$REPO" --limit 20 --json tagName,isPrerelease \
      --jq '[.[] | select(.isPrerelease and (.tagName | contains("canary")))][0].tagName // empty' 2>/dev/null || true)

    if [ -z "$TAG" ]; then
      TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases" \
        | grep -o '"tag_name":"[^"]*canary[^"]*"' \
        | head -1 \
        | cut -d'"' -f4 || true)
    fi

    if [ -z "$TAG" ]; then
      echo "Error: no canary release found" >&2
      exit 1
    fi
  else
    TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep -o '"tag_name":"[^"]*"' \
      | cut -d'"' -f4 || true)

    if [ -z "$TAG" ]; then
      echo "Error: no stable release found" >&2
      exit 1
    fi
  fi

  echo "Installing Clerk CLI ${TAG}..."

  ASSET_NAME="clerk-${TARGET}${EXT}"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}"

  echo "Downloading ${DOWNLOAD_URL}..."
  if ! curl -fsSL -o "${TMPDIR}/${BINARY_NAME}${EXT}" "$DOWNLOAD_URL"; then
    echo "Error: failed to download binary for ${TARGET} from release ${TAG}" >&2
    echo "Check that this platform is supported and the release exists." >&2
    exit 1
  fi

  chmod +x "${TMPDIR}/${BINARY_NAME}${EXT}"
fi

# ─── Install binary ───────────────────────────────────────────────────────────

if [ -z "$INSTALL_DIR" ]; then
  if [ -w /usr/local/bin ]; then
    INSTALL_DIR="/usr/local/bin"
  else
    INSTALL_DIR="${HOME}/.local/bin"
    mkdir -p "$INSTALL_DIR"
  fi
fi

mv "${TMPDIR}/${BINARY_NAME}${EXT}" "${INSTALL_DIR}/${BINARY_NAME}${EXT}"

echo ""
echo "Clerk CLI ${TAG} installed to ${INSTALL_DIR}/${BINARY_NAME}${EXT}"

# Check if install dir is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "Warning: ${INSTALL_DIR} is not in your PATH."
  echo "Add it to your shell profile:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

echo ""
"${INSTALL_DIR}/${BINARY_NAME}${EXT}" --version
