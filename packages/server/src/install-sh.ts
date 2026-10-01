/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * macOS / Linux one-line installer, served as `/install.sh`:
 *
 *   curl -fsSL https://skt.sktailabs.in/install.sh | bash
 *
 * The script checks for node (installing Node 22 LTS itself — brew, the
 * official mac .pkg, or a sudo-free Linux tarball — when missing), runs
 * `npm install -g`,
 * verify — then prints next steps. No secrets, no downloads outside npm
 * and nodejs.org,
 * no sudo needed (npm global prefix is user-writable on stock setups; if
 * not, npm itself tells the user how to fix it). Kept as a module constant
 * (not a static file) so `verify-pack` covers it and tests pin its
 * contents: a silent change here would rewire every install.
 *
 * Portability notes (macOS ships bash 3.2): indexed arrays are avoided —
 * stages ride `case` branches instead — and every expansion is `$var`,
 * `$(...)` or `$((...))` (never `${...}`, which would collide with this
 * file's own template literal). Non-tty runs (CI pipes) skip the animation
 * and install plainly.
 */

export const INSTALL_SH = `#!/usr/bin/env bash
# Trayambak one-line installer (macOS / Linux).
# Run: curl -fsSL https://skt.sktailabs.in/install.sh | bash
set -u

fail() { printf '%s\\n' "error: $1" >&2; exit 1; }

ESC=$(printf '\\033')
CR=$(printf '\\r')

# Node.js bootstrap helpers: when no 'node' is on PATH, install Node 22 LTS
# first, then continue. macOS prefers Homebrew; otherwise (and always on
# Linux) the official nodejs.org release is fetched — a .pkg on mac, a
# sudo-free tarball on Linux. Only nodejs.org is ever touched.
dl_file() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 300 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=300 -O "$2" "$1"
  else
    return 1
  fi
}
dl_stdout() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 60 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=60 "$1"
  else
    return 1
  fi
}
node_lts_version() {
  listing=$(dl_stdout "https://nodejs.org/dist/latest-v22.x/") || return 1
  hit=$(printf '%s' "$listing" | grep -o 'node-v[0-9][0-9.]*' | head -n 1)
  printf '%s' "$hit" | sed 's/^node-//'
}
install_node_lts() {
  os=$(uname -s)
  machine=$(uname -m)
  case $machine in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) fail "unsupported CPU ($machine) — install Node 20+ from https://nodejs.org, then re-run this command." ;;
  esac
  if [ "$os" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    printf 'installing Node.js LTS via Homebrew...\\n'
    brew install node || fail "brew could not install node."
    hash -r
    return 0
  fi
  ver=$(node_lts_version) || fail "could not reach nodejs.org — install Node 20+ from https://nodejs.org, then re-run this command."
  if [ -z "$ver" ]; then
    fail "could not find a Node.js release — install Node 20+ from https://nodejs.org, then re-run this command."
  fi
  if [ "$os" = "Darwin" ]; then
    file="node-v$ver-darwin-$arch.pkg"
    tmp=$(mktemp -d)
    printf 'downloading Node.js %s...\\n' "$ver"
    dl_file "https://nodejs.org/dist/v$ver/$file" "$tmp/$file" || fail "Node.js download failed."
    printf 'installing Node.js (your password may be asked once)...\\n'
    sudo installer -pkg "$tmp/$file" -target / || fail "Node.js pkg install failed."
    rm -rf "$tmp"
    hash -r
  else
    file="node-v$ver-linux-$arch.tar.xz"
    dest="$HOME/.local"
    mkdir -p "$dest"
    printf 'downloading Node.js %s (no sudo needed)...\\n' "$ver"
    dl_file "https://nodejs.org/dist/v$ver/$file" "$dest/$file" || fail "Node.js download failed."
    tar -xJf "$dest/$file" -C "$dest" || fail "could not unpack Node.js."
    rm -f "$dest/$file"
    export PATH="$dest/node-v$ver-linux-$arch/bin:$PATH"
    printf 'note: %s stays on PATH for this session only — add it to your shell rc to keep it.\\n' "$dest/node-v$ver-linux-$arch/bin"
  fi
}

# Animation only on a real terminal: piped/CI runs stay plain and parseable.
if [ -t 1 ]; then
  ANIM=1
else
  ANIM=0
fi

# Full-page clear, then the banner shimmers through violet-to-cyan while the
# third eye opens in stages: shut, stirring, half-open, blazing.
if [ "$ANIM" -eq 1 ]; then
  clear 2>/dev/null || printf '\\033c'
  for sweep in 45 51 87 123 159 195; do
    printf '%s %s[38;5;%smT R A Y A M B A K%s[0m   ' "$CR" "$ESC" "$sweep" "$ESC"
    sleep 0.13
  done
  printf '\\n'
  stage=0
  while [ "$stage" -lt 6 ]; do
    case $stage in
      0) eye='( - )'; glow=240 ;;
      1) eye='( o )'; glow=245 ;;
      2) eye='( O )'; glow=250 ;;
      3) eye='( (O))'; glow=220 ;;
      4) eye='( O )'; glow=220 ;;
      *) eye='( ◉ )'; glow=196 ;;
    esac
    printf '%s%s[38;5;%sm%s%s[0m  opening the third eye...   ' "$CR" "$ESC" "$glow" "$eye" "$ESC"
    sleep 0.3
    stage=$((stage + 1))
  done
  printf '\\n'
  printf ' %s[38;5;196m( ◉ )%s[0m  %s[3mthree eyes of Shiva is coming%s[23m\\n' "$ESC" "$ESC" "$ESC" "$ESC"
  printf '\\n'
  sleep 0.5
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'node not found — installing Node.js LTS first, then trayambak...\\n'
  install_node_lts
  command -v node >/dev/null 2>&1 || fail "Node.js install finished but 'node' is still not on PATH — restart the terminal and re-run this command."
  hash -r
fi
command -v npm >/dev/null 2>&1 || fail "npm not found — it ships with Node 20+ from https://nodejs.org."
node_v=$(node --version)
printf 'node %s found.\\n' "$node_v"
if [ "$ANIM" -eq 1 ]; then
  printf '\\n'
fi

# Download + install with a live comet bar: npm runs in the background while
# the foreground paints a glowing comet (head + fading trail) over a dim
# track, plus the eye spinner and elapsed time.
log=$(mktemp)
npm install -g @skt-ai-labs/trayambak-cli >"$log" 2>&1 &
NPMPID=$!
start=$SECONDS
width=24
i=0
while kill -0 "$NPMPID" 2>/dev/null; do
  elapsed=$((SECONDS - start))
  if [ "$elapsed" -gt 600 ]; then
    kill "$NPMPID" 2>/dev/null || true
    fail "install timed out after 10 minutes (network/npm issue?)"
  fi
  if [ "$ANIM" -eq 1 ]; then
    pos=$((i % width))
    bar=""
    b=0
    while [ "$b" -lt "$width" ]; do
      d=$(((pos - b + width) % width))
      if [ "$d" -eq 0 ]; then
        bar="$bar$ESC[38;5;213m█"
      elif [ "$d" -eq 1 ]; then
        bar="$bar$ESC[38;5;141m▓"
      elif [ "$d" -eq 2 ]; then
        bar="$bar$ESC[38;5;99m▒"
      else
        bar="$bar$ESC[38;5;238m─"
      fi
      b=$((b + 1))
    done
    case $((i % 4)) in
      0) eye='◉' ;;
      1) eye='◎' ;;
      2) eye='◯' ;;
      *) eye='◎' ;;
    esac
    printf '%s%s [%s%s[0m] downloading trayambak... %s s elapsed   ' "$CR" "$eye" "$bar" "$ESC" "$elapsed"
    sleep 0.15
  else
    sleep 2
  fi
  i=$((i + 1))
done
if [ "$ANIM" -eq 1 ]; then
  printf '\\n'
fi
wait "$NPMPID"
code=$?
if [ "$code" -ne 0 ]; then
  tail -20 "$log" >&2 || true
  rm -f "$log"
  fail "npm install failed (exit $code) — full log was above."
fi
rm -f "$log"
printf 'download + install complete.\\n'
printf '\\n'

ver=$(trayambak --version 2>/dev/null) || fail "install finished but 'trayambak' is not on PATH — restart the terminal and try again."
if [ "$ANIM" -eq 1 ]; then
  printf ' %s[38;5;46m( ◉ )%s[0m  %s installed.\\n' "$ESC" "$ESC" "$ver"
else
  printf '%s installed.\\n' "$ver"
fi
printf '\\n'
printf '%s[3mthree eyes of Shiva is coming%s[23m — to your terminal.\\n' "$ESC" "$ESC"
printf '\\n'
printf 'Next steps:\\n'
printf '  1. trayambak            # open the TUI\\n'
printf '  2. /provider add        # connect your model backend + API key\\n'
printf '  3. /github login        # authorize GitHub (browser opens)\\n'
printf '  4. /devmode trial       # or paste a license: /devmode on 1102-XXXX-XXXX-XXXX\\n'
`
