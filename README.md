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
and remove control files. Sanitized logs are written to `logs/` and uploaded even
on failure. Native entries and temporary installations are cleaned in `finally`;
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
