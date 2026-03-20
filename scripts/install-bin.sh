#!/usr/bin/env bash
# Exit on error, catch unset variables, and fail a pipeline if any step fails.
set -euo pipefail

# Resolve this file’s directory, then the repo root, and run subsequent commands from there.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# User-level bin dir
LOCAL_BIN="${HOME}/.local/bin"

# Marker (comment) in user profile for auto-updating the PATH
MARKER="# clerk-cli: ~/.local/bin on PATH"

# Compile the standalone binary, ensure the bin directory exists, then copy the binary into place.
bun run build:bin
mkdir -p "${LOCAL_BIN}"
install -m 755 "${REPO_ROOT}/dist/clerk" "${LOCAL_BIN}/clerk"

# Return true if we (or the user) already wired ~/.local/bin into shell startup files.
path_snippet_present() {
  local f
  for f in "${HOME}/.zshrc" "${HOME}/.bash_profile" "${HOME}/.bashrc" "${HOME}/.profile"; do
    [[ -f "${f}" ]] || continue
    grep -qF "${MARKER}" "${f}" && return 0
    grep -qF ".local/bin" "${f}" && return 0
  done
  return 1
}

# Pick the startup file that matches the user’s login shell (macOS default is zsh).
pick_rc() {
  case "$(basename "${SHELL:-/bin/zsh}")" in
    zsh) echo "${HOME}/.zshrc" ;;
    bash) echo "${HOME}/.bash_profile" ;;
    *) echo "${HOME}/.profile" ;;
  esac
}

# Append PATH setup only when it isn’t already covered in the usual shell startup files.
added_path_to_rc=false
rc=""
if path_snippet_present; then
  :
else
  rc="$(pick_rc)"
  {
    echo ""
    echo "${MARKER}"
    echo "export PATH=\"\${HOME}/.local/bin:\${PATH}\""
  } >>"${rc}"
  added_path_to_rc=true
fi

# Friendly recap of what ran (always runs after a successful install).
echo ""
echo "Installation complete."
echo "  • Built the standalone clerk binary"
echo "  • Copied it to ${LOCAL_BIN}/clerk"
if [[ "${added_path_to_rc}" == true ]]; then
  echo "  • Added ~/.local/bin to your PATH via ${rc} (new terminals will pick this up automatically)."
  echo "  • To reload your PATH in this terminal, run: source ${rc}"
fi
