#!/bin/bash
#
# Build, sign, and notarize a macOS .pkg installer for the Clerk CLI
#
# Required environment variables:
#   VERSION                  - Version string (e.g., v1.0.0)
#   APPLE_TEAM_ID            - Apple Developer Team ID
#   APP_IDENTITY             - Developer ID Application certificate name
#   INSTALLER_IDENTITY       - Developer ID Installer certificate name
#   APPLE_ID                 - Apple ID for notarization
#   APPLE_APP_SPECIFIC_PASSWORD - App-specific password for notarization
#
# Usage:
#   ./scripts/build-macos-pkg.sh <arch>
#   where <arch> is "amd64" or "arm64"

set -euo pipefail

ARCH="${1:-}"
if [[ -z "$ARCH" ]]; then
    echo "Usage: $0 <arch>"
    echo "  arch: amd64 or arm64"
    exit 1
fi

# Map Go arch to Apple arch names
case "$ARCH" in
    amd64)
        APPLE_ARCH="x86_64"
        ;;
    arm64)
        APPLE_ARCH="arm64"
        ;;
    *)
        echo "Error: Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

VERSION="${VERSION:-dev}"
VERSION_NUM="${VERSION#v}"
BINARY_NAME="clerk"
PKG_IDENTIFIER="com.clerk.cli"
INSTALL_LOCATION="/usr/local/bin"

DIST_DIR="dist"
WORK_DIR="${DIST_DIR}/macos-${ARCH}"
BINARY_PATH="${DIST_DIR}/clerk-${VERSION}-darwin-${ARCH}"
UNSIGNED_PKG="${WORK_DIR}/${BINARY_NAME}-unsigned.pkg"
SIGNED_PKG="${DIST_DIR}/clerk-${VERSION}-darwin-${ARCH}.pkg"

echo "==> Building macOS .pkg for ${ARCH}"
echo "    Version: ${VERSION}"
echo "    Binary: ${BINARY_PATH}"

# Verify binary exists
if [[ ! -f "$BINARY_PATH" ]]; then
    echo "Error: Binary not found at ${BINARY_PATH}"
    exit 1
fi

# Create work directory
rm -rf "$WORK_DIR"
mkdir -p "${WORK_DIR}/payload${INSTALL_LOCATION}"

# Copy binary to payload
cp "$BINARY_PATH" "${WORK_DIR}/payload${INSTALL_LOCATION}/${BINARY_NAME}"
chmod 755 "${WORK_DIR}/payload${INSTALL_LOCATION}/${BINARY_NAME}"

# Sign the binary
echo "==> Signing binary with Developer ID Application certificate"
codesign --force --options runtime \
    --sign "${APP_IDENTITY}" \
    --timestamp \
    "${WORK_DIR}/payload${INSTALL_LOCATION}/${BINARY_NAME}"

# Verify signature
echo "==> Verifying binary signature"
codesign --verify --deep --strict --verbose=2 \
    "${WORK_DIR}/payload${INSTALL_LOCATION}/${BINARY_NAME}"

# Build unsigned pkg
echo "==> Building unsigned .pkg"
pkgbuild \
    --root "${WORK_DIR}/payload" \
    --identifier "${PKG_IDENTIFIER}" \
    --version "${VERSION_NUM}" \
    --install-location "/" \
    "$UNSIGNED_PKG"

# Sign the pkg
echo "==> Signing .pkg with Developer ID Installer certificate"
productsign \
    --sign "${INSTALLER_IDENTITY}" \
    --timestamp \
    "$UNSIGNED_PKG" \
    "$SIGNED_PKG"

# Verify pkg signature
echo "==> Verifying .pkg signature"
pkgutil --check-signature "$SIGNED_PKG"

# Notarize the pkg
echo "==> Submitting .pkg for notarization"
xcrun notarytool submit "$SIGNED_PKG" \
    --apple-id "${APPLE_ID}" \
    --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
    --team-id "${APPLE_TEAM_ID}" \
    --wait

# Staple the notarization ticket
echo "==> Stapling notarization ticket"
xcrun stapler staple "$SIGNED_PKG"

# Verify stapling
echo "==> Verifying stapled .pkg"
xcrun stapler validate "$SIGNED_PKG"

# Cleanup
rm -rf "$WORK_DIR"

echo "==> Successfully created signed and notarized .pkg: ${SIGNED_PKG}"
