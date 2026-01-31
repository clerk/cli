#!/bin/bash
#
# Export Apple Developer certificates for GitHub Actions
#
# This script helps you export your Developer ID certificates as base64-encoded
# strings that can be stored as GitHub secrets.
#
# Prerequisites:
# 1. Have Xcode installed
# 2. Have your Developer ID Application and Installer certificates in Keychain Access
#
# Usage:
#   ./scripts/export-certs-for-github.sh

set -euo pipefail

echo "=== Apple Developer Certificate Export for GitHub Actions ==="
echo ""
echo "This script will help you export your certificates for use in GitHub Actions."
echo ""

# List available Developer ID certificates
echo "Available Developer ID certificates in your keychain:"
echo ""
security find-identity -v -p codesigning | grep "Developer ID" || echo "  (none found)"
echo ""

echo "To export your certificates:"
echo ""
echo "1. Open Keychain Access"
echo "2. Find your 'Developer ID Application' certificate"
echo "3. Right-click → Export → Save as .p12 file"
echo "4. Set a password (you'll need this for APPLE_CERTIFICATE_PASSWORD)"
echo "5. Repeat for 'Developer ID Installer' certificate"
echo ""

read -p "Enter path to Developer ID Application .p12 file: " APP_CERT_PATH
read -p "Enter path to Developer ID Installer .p12 file: " INSTALLER_CERT_PATH

if [[ ! -f "$APP_CERT_PATH" ]]; then
    echo "Error: File not found: $APP_CERT_PATH"
    exit 1
fi

if [[ ! -f "$INSTALLER_CERT_PATH" ]]; then
    echo "Error: File not found: $INSTALLER_CERT_PATH"
    exit 1
fi

echo ""
echo "=== Base64-encoded certificates ==="
echo ""
echo "Add these as GitHub secrets:"
echo ""

echo "--- APPLE_DEVELOPER_ID_APPLICATION_P12 ---"
base64 -i "$APP_CERT_PATH"
echo ""
echo "--- END ---"
echo ""

echo "--- APPLE_DEVELOPER_ID_INSTALLER_P12 ---"
base64 -i "$INSTALLER_CERT_PATH"
echo ""
echo "--- END ---"
echo ""

echo "=== Other required secrets ==="
echo ""
echo "APPLE_CERTIFICATE_PASSWORD: (the password you used when exporting the .p12 files)"
echo "APPLE_ID: (your Apple ID email)"
echo "APPLE_TEAM_ID: (your 10-character team ID, visible in Apple Developer portal)"
echo "APPLE_DEVELOPER_NAME: (your developer name exactly as it appears in the certificate)"
echo "APPLE_APP_SPECIFIC_PASSWORD: (generate at https://appleid.apple.com)"
echo ""
echo "=== Repository variable ==="
echo ""
echo "Set MACOS_SIGNING_ENABLED=true in your repository variables to enable signing."
