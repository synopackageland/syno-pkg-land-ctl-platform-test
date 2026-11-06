# ctl native credential platform smoke

Standalone MIT test harness for the published `@synopackageland/cli` package.
It installs an exact npm version at runtime, never builds or fetches CLI source,
and only contacts a disposable loopback fixture. Node 24 and npm are required.
A local `.tgz` can replace the version for local candidate checks.

Run the **ctl native credential platform smoke** Actions workflow with
`cli_version` set to a release containing native credential support. The seven matrix jobs
cover Linux, macOS (a disposable unlocked Keychain) and Windows in keychain and encrypted-file vault modes, plus
Linux without Secret Service. Windows runs each mode under **both PowerShell
and cmd**, using real ConPTY from the pinned, test-only `@lydell/node-pty` package.

Local examples (run from this directory; set `CLI_VERSION` to that exact version first):

```sh
# Linux: install python3, dbus-x11, gnome-keyring and libsecret-tools first.
dbus-run-session -- bash scripts/linux.sh "$CLI_VERSION" keychain
dbus-run-session -- bash scripts/linux.sh "$CLI_VERSION" vault
bash scripts/linux.sh "$CLI_VERSION" headless
# macOS: use the runner's unlocked login Keychain.
node run-smoke.mjs "$CLI_VERSION" keychain
node run-smoke.mjs "$CLI_VERSION" vault
```

```powershell
# Windows: npm installs only the test repository's ConPTY driver here.
npm ci --ignore-scripts
node run-smoke.mjs $env:CLI_VERSION keychain pwsh
node run-smoke.mjs $env:CLI_VERSION vault pwsh
node run-smoke.mjs $env:CLI_VERSION keychain cmd
node run-smoke.mjs $env:CLI_VERSION vault cmd
```

Each run tests header tokens and FreshRSS ClientLogin: missing/list, enrollment,
native store readback, call, 401 invalidation, failed update preserving the old
record, interactive renewal without replay, manual rerun, ordinary update, 403
preserving state, and local-only reset. Lists must not probe native APIs; native
requests must carry no DSM session headers. Vault checks include decryption,
nonce rotation and plaintext absence. Windows vault runs PowerShell `Get-Acl`
checks for owner, disabled inheritance and current-user-only access, including
paths containing spaces and an apostrophe. Headless Linux must explicitly reject
the default keychain and recommend encrypted-file before testing the vault.

All passwords/tokens are synthetic and supplied over a private temporary control
file. PTY drivers assert hidden input never echoes, redact failures before output,
and remove control files. The Windows driver streams STEP start/completion,
subprocess phase and matched prompt names immediately; input values are never
logged. Each expect has a 90-second deadline, including waits with noisy or
missing output. Failure reports the current STEP, phase, expected prompt pattern
and the last approximately 2 KB of redacted screen text. Sanitized logs are written to `logs/` and uploaded even
on failure. Logs are persisted on every progress message. An independent
supervisor enforces a 95-second driver silence limit and a 9-minute total limit;
Windows process trees are stopped with external taskkill, without waiting for
ConPTY shutdown callbacks. Windows install/run/upload steps have 10-minute
limits within a 40-minute job. Each shell has an always-run artifact upload
immediately after its run, as well as the final combined upload. Native entries and temporary installations are cleaned in `finally`;
a forcibly terminated process may require runner disposal. Do not upload raw
terminal captures, control files or temporary CLI state.

Linux container reproduction uses `docker build -t ctl-platform-smoke .` followed
by `docker run --rm ctl-platform-smoke dbus-run-session -- bash scripts/linux.sh
<exact-version> keychain` (repeat with `vault`; omit `dbus-run-session --` for `headless`).
A local registry mirror can be selected with `SMOKE_NPM_REGISTRY`; hosted CI uses
the public npm registry. This test depends on the installed CLI's packaged
`dist/ctl` modules to construct and inspect fixtures; incompatible versions fail
with a prerequisite error. Choose a release containing native credential support.

macOS and Windows require actual hosted runs before claiming platform acceptance.
ConPTY does not silently fall back to stdin or skip hidden-prompt assertions.

PowerShell runs a fixed encoded command with NoProfile/NonInteractive and
PSReadLine removed; Node still receives a real ConPTY terminal. cmd uses a fixed
batch file with quoted executable/version arguments. Input uses CR (never CRLF),
prompt matching tolerates CRLF/ANSI/chunk boundaries and repaint, and cursor
queries receive terminal replies. No echo is required before advancing.
`CTL_SMOKE_EXPECT_TIMEOUT_MS` and `CTL_SMOKE_TOTAL_TIMEOUT_MS` can shorten the
default deadlines for local failure-injection checks; they cannot increase them.
A possible Credential Manager dialog or native call stall is reported with its
last subprocess/store phase; native Windows behavior still needs a hosted run.
