// Windows uses real ConPTY, launched through each requested shell.
// --direct is a Unix development check of this driver's parser and leak assertions.
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import pty from '@lydell/node-pty';

const [shell, version, ...options] = process.argv.slice(2);
assert.ok(['pwsh', 'cmd', '--direct'].includes(shell) && version,
  'Usage: node drive-conpty.mjs <pwsh|cmd> <exact-version|local.tgz> [--vault]');
assert.ok(shell === '--direct' || process.platform === 'win32', 'Windows shell required');
const cwd = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'ctl-driver-'));
const control = join(root, 'control.jsonl');
writeFileSync(control, '', {mode: 0o600});
const env = {...process.env, CTL_SMOKE_CONTROL: control, CTL_SMOKE_VERSION: version};
const records = () => readFileSync(control, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const command = shell === '--direct' ? process.execPath : shell === 'pwsh' ? 'pwsh.exe' : process.env.ComSpec ?? 'cmd.exe';
// Only fixed commands reach a shell. Version/path stays in an environment variable.
const args = shell === '--direct' ? ['smoke.mjs', version, ...options]
  : shell === 'pwsh' ? ['-NoLogo', '-NoProfile', '-Command',
    `& node smoke.mjs $env:CTL_SMOKE_VERSION ${options.includes('--vault') ? '--vault' : ''}; exit $LASTEXITCODE`]
  : ['/d', '/s', '/c', `node smoke.mjs "%CTL_SMOKE_VERSION%" ${options.includes('--vault') ? '--vault' : ''}`];
const prompts = /Enter a new token now\? \[y\/N\] |Open the credential page in your browser\? \[y\/N\] |Native API token \(hidden\): |Native API password \(hidden\): |Native account name: |Independent vault passphrase \(hidden\): |Confirm vault passphrase \(hidden\): |Native vault passphrase \(hidden\): |Store this App credential locally\? \[y\/N\] /g;
let terminal;
let raw = '', offset = 0, hidden = 0, failure = false;
try {
  terminal = pty.spawn(command, args, {cwd, env, cols: 240, rows: 60, name: 'xterm-256color'});
  const timer = setTimeout(() => { failure = true; terminal.kill(); }, 600_000);
  const code = await new Promise(resolve => {
    terminal.onData(chunk => {
      raw += chunk;
      const text = stripVTControlCharacters(raw);
      prompts.lastIndex = offset;
      let match;
      try {
        while ((match = prompts.exec(text))) {
          const state = records().at(-1);
          assert.ok(state, 'Missing fixture control record');
          const prompt = match[0];
          const value = prompt.startsWith('Open ') ? 'n'
            : prompt.startsWith('Enter ') ? state.label.includes('401 decline') ? 'n' : 'y'
            : prompt.startsWith('Native account') ? 'reader'
            : prompt.includes('passphrase') ? state.passphrase
            : prompt.startsWith('Native API') ? state.secret : 'y';
          assert.ok(value, 'Unexpected credential prompt');
          if (prompt.includes('(hidden)')) hidden++;
          offset = match.index + prompt.length;
          // Let the CLI switch the terminal to raw mode before sending input.
          setTimeout(() => { try { terminal.write(value + '\r'); } catch { failure = true; } }, 80);
        }
      } catch {
        failure = true;
        terminal.kill();
      }
    });
    terminal.onExit(({exitCode}) => resolve(exitCode));
  });
  clearTimeout(timer);
  let text = stripVTControlCharacters(raw);
  let leaked = false;
  for (const state of records()) {
    for (const value of [state.secret, state.passphrase]) {
      if (value && text.includes(value)) {
        leaked = true;
        text = text.replaceAll(value, '[REDACTED]');
      }
    }
    text = text.replaceAll(state.root, '<temporary-directory>');
    text = text.replaceAll(encodeURI(state.root), '<temporary-directory>');
  }
  const tokens = /smoke-[0-9a-f]{16}-[\w-]+/g;
  leaked ||= tokens.test(text);
  text = text.replace(tokens, '[REDACTED]');
  for (const value of ['synthetic-dsm-password', 'smoke-dsm-session', 'smoke-dsm-token',
    'wrong-smoke-token', 'wrong-smoke-password']) {
    if (text.includes(value)) { leaked = true; text = text.replaceAll(value, '[REDACTED]'); }
  }
  process.stdout.write(text);
  if (failure || leaked || !hidden || !text.includes('ALL PLATFORM SMOKE CHECKS PASSED')) {
    console.log(`FAIL PTY: echo=${leaked}, driver=${failure}, hidden-prompts=${hidden}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${shell} PTY hidden-input assertions: ${hidden}`);
    process.exitCode = code;
  }
} finally {
  rmSync(root, {recursive: true, force: true});
}
