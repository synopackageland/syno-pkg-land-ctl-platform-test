#!/usr/bin/env bash
# Call inside dbus-run-session for keychain/vault; headless intentionally has no bus.
set -euo pipefail
version=${1:?Provide an exact CLI version or tarball}
mode=${2:-keychain}
if [[ "$mode" == headless ]]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$(mktemp -u)/unavailable"
  exec node run-smoke.mjs "$version" headless
fi
if [[ "$mode" != keychain && "$mode" != vault ]]; then
  exit 2
fi
session=$(mktemp -d)
export XDG_RUNTIME_DIR="$session/run" XDG_DATA_HOME="$session/data" XDG_CONFIG_HOME="$session/config"
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"
chmod 700 "$session" "$XDG_RUNTIME_DIR"
cleanup() {
  if [[ -n ${daemon_pid:-} ]]; then kill "$daemon_pid" 2>/dev/null || true; fi
  rm -rf "$session"
}
trap cleanup EXIT
# No real desktop login keyring or credentials are used.
# The unlock password is synthetic and stays on stdin, never in logs or argv.
printf '%s' 'disposable-keyring-fixture' | gnome-keyring-daemon --foreground --unlock --components=secrets >"$session/daemon.log" 2>&1 &
daemon_pid=$!
# Wait for our daemon to own the bus name before probing; a premature secret-tool
# call would D-Bus-activate a second, locked daemon outside this disposable setup.
owned=false
for attempt in {1..30}; do
  kill -0 "$daemon_pid" 2>/dev/null || break
  owner=$(dbus-send --session --type=method_call --print-reply \
    --dest=org.freedesktop.DBus /org/freedesktop/DBus \
    org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets)
  if [[ "$owner" == *"boolean true"* ]]; then owned=true; break; fi
  sleep 1
done
[[ "$owned" == true ]]
# Independent availability probe, also bounded if the daemon failed to start.
ready=false
for attempt in {1..30}; do
  if printf '%s' 'disposable-probe-fixture' | timeout 5 secret-tool store --label='Credential smoke readiness' purpose ctl-smoke-ready 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]]
probe=$(timeout 5 secret-tool lookup purpose ctl-smoke-ready)
[[ "$probe" == disposable-probe-fixture ]]
secret-tool clear purpose ctl-smoke-ready
node run-smoke.mjs "$version" "$mode"
