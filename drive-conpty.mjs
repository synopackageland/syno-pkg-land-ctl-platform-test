// Real ConPTY on Windows; --direct exercises this driver with a Unix PTY locally.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import pty from '@lydell/node-pty';
import {newPromptRegex, promptPattern, plain, redact, tail, timeoutSetting} from './pty-diagnostics.mjs';

const [shell, version, ...options] = process.argv.slice(2);
assert.ok(['pwsh', 'cmd', '--direct'].includes(shell) && version,
  'Usage: node drive-conpty.mjs <pwsh|cmd> <exact-version|local.tgz> [--vault]');
assert.ok(options.every(option => ['--vault', '--headless'].includes(option)), 'Unknown mode');
assert.ok(shell === '--direct' || process.platform === 'win32', 'Windows shell required');
const waitMs = timeoutSetting('CTL_SMOKE_EXPECT_TIMEOUT_MS', 90_000);
const cwd = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'ctl-driver-'));
const control = join(root, 'control.jsonl');
writeFileSync(control, '', {mode: 0o600});
const env = {...process.env, CTL_SMOKE_CONTROL: control, CTL_SMOKE_VERSION: version,
  CTL_SMOKE_NODE: process.execPath, CTL_SMOKE_MODE_FLAG: options[0] ?? ''};
const command = shell === '--direct' ? process.execPath : shell === 'pwsh' ? 'pwsh.exe' : process.env.ComSpec ?? 'cmd.exe';
// NonInteractive applies to the shell, not the Node child's real terminal.
// EncodedCommand avoids native-shell quotation rules. No user value becomes code.
const powershell = 'Remove-Module PSReadLine -ErrorAction SilentlyContinue; & $env:CTL_SMOKE_NODE smoke.mjs $env:CTL_SMOKE_VERSION @(' +
  (options.length ? options.map(option => `'${option}'`).join(',') : '') + '); exit $LASTEXITCODE';
const args = shell === '--direct' ? ['smoke.mjs', version, ...options]
  : shell === 'pwsh' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(powershell, 'utf16le').toString('base64')]
  : ['/d', '/q', '/v:off', '/s', '/c', 'scripts\\windows-smoke.cmd'];
const prompts = newPromptRegex();
let terminal, raw = '', offset = 0, queryOffset = 0, hidden = 0;
let states = [], recordCount = 0, state = {label: 'startup', phase: 'spawn shell'};
let deadline = Date.now() + waitMs, expected = 'first STEP/control event or prompt: ' + promptPattern;
let answered = new Set(), stepKey, stopping = false, poll;
const writes = new Set();
const log = message => console.log(redact(message, states).text);
function snapshot() {
  if (!process.connected) return;
  // Only redacted data crosses IPC. The supervisor can diagnose a blocked event loop.
  const screen = tail(redact(raw, states).text) || '<no PTY screen received>';
  process.send({type:'diagnostic', step:redact(state.label, states).text, phase:redact(state.phase ?? 'unknown', states).text, expected:redact(expected, states).text, screen}, () => {});
}
function waiting(reason) {
  expected = reason;
  deadline = Date.now() + waitMs;
  snapshot();
}
function readControl() {
  const source = readFileSync(control, 'utf8');
  // appendFileSync can be observed mid-write; only parse complete JSONL records.
  const rows = source.slice(0, source.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
  states = rows;
  for (const row of rows.slice(recordCount)) {
    state = row;
    if (row.event === 'diagnostic' && typeof row.message === 'string') log(row.message);
    if (row.event === 'step-start' || (!row.event && stepKey !== row.label)) {
      stepKey = row.step ?? row.label;
      answered = new Set();
      log(`[STEP START] ${row.label}`);
    } else if (row.event === 'step-done') {
      log(`[STEP DONE] ${row.label} exit=${row.exitCode}`);
    }
    log(`[WAIT] STEP=${row.label}; phase=${row.phase ?? row.event ?? 'prompt'}; limit=${waitMs}ms`);
    waiting('prompt pattern: ' + promptPattern + ' OR STEP/subprocess completion');
  }
  recordCount = rows.length;
}
async function killTree() {
  if (!terminal?.pid) return;
  if (process.platform === 'win32') {
    // Do not call terminal.kill(): it can be deferred before the first ConPTY data.
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(terminal.pid), '/t', '/f'],
        {stdio: 'ignore', windowsHide: true});
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 2000);
      killer.once('error', () => { clearTimeout(timer); resolve(); });
      killer.once('close', () => { clearTimeout(timer); resolve(); });
    });
  } else {
    try { process.kill(-terminal.pid, 'SIGKILL'); }
    catch { try { process.kill(terminal.pid, 'SIGKILL'); } catch {} }
  }
}
async function finish(code, reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(poll);
  for (const timer of writes) clearTimeout(timer);
  try { readControl(); } catch { /* Keep the last fully parsed control state. */ }
  const safe = redact(raw, states);
  if (!reason && (safe.leaked || !hidden || !safe.text.includes('ALL PLATFORM SMOKE CHECKS PASSED'))) {
    reason = `PTY exited ${code}; echo=${safe.leaked}, hidden-prompts=${hidden}, completion=${safe.text.includes('ALL PLATFORM SMOKE CHECKS PASSED')}`;
  }
  if (reason) {
    log(`[FAIL] ${reason}; STEP=${state.label}; phase=${state.phase ?? 'unknown'}`);
    log(`[EXPECT] ${expected}`);
    console.log('[SCREEN last <=2048 bytes, redacted]\n' + (tail(safe.text) || '<no PTY screen received>'));
    code = 1;
  } else {
    process.stdout.write(safe.text);
    log(`PASS ${shell} PTY hidden-input assertions: ${hidden}`);
  }
  if (reason) await killTree();
  try { rmSync(root, {recursive: true, force: true}); } catch { code = 1; }
  // A native PTY handle can keep the event loop alive after failure or onExit.
  // The supervisor also has a separate deadline if native code blocks this loop.
  process.stdout.write(`[DRIVER EXIT] code=${code}\n`, () => process.exit(code));
  setTimeout(() => process.exit(code), 200).unref();
}
process.once('SIGTERM', () => void finish(1, 'driver received SIGTERM'));
process.once('SIGINT', () => void finish(1, 'driver received SIGINT'));
log(`[DRIVER START] shell=${shell}; expect-timeout=${waitMs}ms; hidden input does not require echo`);
snapshot();
// Start before native spawn; the independent supervisor covers a blocking spawn.
poll = setInterval(() => {
  try { readControl(); }
  catch { void finish(1, 'cannot read fixture control state'); return; }
  if (Date.now() >= deadline) void finish(1, `expect timeout after ${waitMs}ms`);
}, Math.min(100, waitMs / 4));
try {
  terminal = pty.spawn(command, args, {cwd, env, cols: 240, rows: 60, name: 'xterm-256color', conptyInheritCursor: false});
  terminal.onData(chunk => {
    if (stopping) return;
    raw += chunk;
    try {
      readControl();
      snapshot();
      // Reply to terminal cursor queries, even when split across data events.
      const queries = /\x1b\[\??6n/g;
      queries.lastIndex = queryOffset;
      let query;
      while ((query = queries.exec(raw))) {
        queryOffset = query.index + query[0].length;
        terminal.write(query[0].includes('?')?'\x1b[?1;1R':'\x1b[1;1R');
        log('[TERMINAL] answered cursor-position query');
      }
      const text = plain(raw);
      prompts.lastIndex = offset;
      let match;
      while ((match = prompts.exec(text))) {
        offset = match.index + match[0].length;
        const prompt = match[0].replace(/\s+/g, ' ').trim();
        if (answered.has(prompt)) { log(`[PROMPT REPAINT] STEP=${state.label}; repeated=${prompt}; not resending`); continue; }
        answered.add(prompt);
        const value = prompt.startsWith('Open ') ? 'n'
          : prompt.startsWith('Enter ') ? state.label.includes('401 decline') ? 'n' : 'y'
          : prompt.startsWith('Native account') ? 'reader'
          : prompt.includes('passphrase') ? state.passphrase
          : prompt.startsWith('Native API') ? state.secret : 'y';
        assert.ok(value, 'Unexpected credential prompt');
        if (prompt.includes('(hidden)')) hidden++;
        log(`[PROMPT] STEP=${state.label}; matched=${prompt}; sending ${prompt.includes('(hidden)') ? 'hidden fixture' : 'answer'}`);
        waiting('after ' + prompt + ': next prompt pattern: ' + promptPattern + ' OR STEP/subprocess completion');
        const timer = setTimeout(() => {
          writes.delete(timer);
          if (stopping) return;
          try { terminal.write(value + '\r'); } // CR only; CRLF would submit twice.
          catch { void finish(1, 'PTY input write failed'); }
        }, 80);
        writes.add(timer);
      }
    } catch { void finish(1, 'prompt/control processing failed'); }
  });
  terminal.onExit(({exitCode}) => { void finish(exitCode ?? 1); });
} catch (error) { void finish(1, `PTY spawn failed (${error.name}): ${error.message}`); }
