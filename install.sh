#!/usr/bin/env bash
# expect2 IDE (ide2) — Cross-platform installer (macOS, Linux, Windows Git Bash / WSL)
# Usage:
#   ./install.sh                  # Install from local checkout (if run inside repo) or clone
#   IDE2_BIN_DIR=~/.local/bin ./install.sh

set -euo pipefail

BOLD="\033[1m"
DIM="\033[2m"
INV="\033[7m"
SAFE="\033[92m"
UNSAFE="\033[91m"
RESET="\033[0m"

info()  { printf "  %b\n" "$1"; }
ok()    { printf "  ${SAFE}✔${RESET} %b\n" "$1"; }
fail()  { printf "  ${UNSAFE}✘${RESET} %b\n" "$1" >&2; exit 1; }

printf "\n  ${BOLD}ide${INV}2${RESET} ${DIM}installer${RESET}\n\n"

# 1. Verify git & node
command -v git >/dev/null 2>&1 || fail "git is required but was not found on PATH."

# 2. Verify or locate bun
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "${HOME}/.bun/bin/bun" ]; then
    export PATH="${HOME}/.bun/bin:${PATH}"
  else
    info "bun not found — installing bun to ~/.bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="${HOME}/.bun/bin:${PATH}"
  fi
fi
ok "bun $(bun --version)"

# 3. Ensure node is available for CLI launcher (or shim via bun if needed)
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version)"
fi

# 4. Determine source directory
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

INSTALL_HOME="${IDE2_HOME:-${HOME}/.expect2-ide}"
mkdir -p "${INSTALL_HOME}"

if [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/package.json" ] && grep -qE '"name": "(ide2|expect2-ide)"' "${SCRIPT_DIR}/package.json"; then
  APP_DIR="${SCRIPT_DIR}"
  ok "using checkout at ${APP_DIR}"
else
  REPO_URL="${IDE2_REPO_URL:-https://github.com/expect2/expect2-ide.git}"
  APP_DIR="${INSTALL_HOME}/app"
  if [ -d "${APP_DIR}/.git" ]; then
    info "updating ${APP_DIR}..."
    git -C "${APP_DIR}" pull --ff-only
  else
    info "cloning ${REPO_URL} -> ${APP_DIR}..."
    git clone "${REPO_URL}" "${APP_DIR}"
  fi
fi

# 5. Install dependencies & build bundles
info "installing dependencies..."
(cd "${APP_DIR}" && bun install)
info "building ide2 bundles..."
(cd "${APP_DIR}" && bun run build)
chmod +x "${APP_DIR}/bin/ide2.mjs"
ok "built ide2"

# 6. Select target bin directory on PATH (macOS, Linux, Git Bash / MSYS2 / WSL)
choose_bin_dir() {
  if [ -n "${IDE2_BIN_DIR:-}" ]; then
    printf "%s" "${IDE2_BIN_DIR}"
    return
  fi
  for candidate in "${HOME}/.local/bin" "${HOME}/.bun/bin" "${HOME}/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
    case ":${PATH}:" in
      *":${candidate}:"*)
        if [ -w "${candidate}" ] || [ ! -e "${candidate}" ]; then
          printf "%s" "${candidate}"
          return
        fi
        ;;
    esac
  done
  printf "%s" "${HOME}/.local/bin"
}

BIN_DIR="$(choose_bin_dir)"
mkdir -p "${BIN_DIR}"

# 7. Write cross-platform launcher shim (works even if node isn't on GUI/login PATH by falling back to bun)
TARGET_BIN="${BIN_DIR}/ide2"
cat > "${TARGET_BIN}" <<EOF
#!/usr/bin/env bash
if command -v node >/dev/null 2>&1; then
  exec node "${APP_DIR}/bin/ide2.mjs" "\$@"
elif [ -x "/opt/homebrew/bin/node" ]; then
  exec "/opt/homebrew/bin/node" "${APP_DIR}/bin/ide2.mjs" "\$@"
elif command -v bun >/dev/null 2>&1; then
  exec bun "${APP_DIR}/bin/ide2.mjs" "\$@"
elif [ -x "\${HOME}/.bun/bin/bun" ]; then
  exec "\${HOME}/.bun/bin/bun" "${APP_DIR}/bin/ide2.mjs" "\$@"
else
  echo "ide2: neither node nor bun found on PATH" >&2
  exit 1
fi
EOF
chmod +x "${TARGET_BIN}"

# Windows Git Bash / Command Prompt .cmd companion shim
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    WIN_APP_DIR="$(cygpath -w "${APP_DIR}")"
    cat > "${BIN_DIR}/ide2.cmd" <<CMDEOF
@echo off
where node >nul 2>nul
if %errorlevel%==0 (
  node "${WIN_APP_DIR}\\bin\\ide2.mjs" %*
) else (
  bun "${WIN_APP_DIR}\\bin\\ide2.mjs" %*
)
CMDEOF
    ok "installed Windows wrapper ${BIN_DIR}/ide2.cmd"
    ;;
esac

ok "installed ${BOLD}ide2${RESET} -> ${TARGET_BIN}"

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    printf "\n  Run ${BOLD}ide2 .${RESET} inside any git repository or worktree.\n\n"
    ;;
  *)
    printf "\n  Add ${BOLD}${BIN_DIR}${RESET} to your PATH:\n"
    printf "    export PATH=\"${BIN_DIR}:\$PATH\"\n"
    printf "  Then run ${BOLD}ide2 .${RESET} inside any git repository.\n\n"
    ;;
esac
