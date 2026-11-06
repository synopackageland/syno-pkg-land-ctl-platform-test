// Independent watchdog: native ConPTY code must not be able to hang the job.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, writeFileSync, appendFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tail, timeoutSetting, promptPattern} from './pty-diagnostics.mjs';
const [source, mode = 'keychain', shell = 'posix'] = process.argv.slice(2);
assert.ok(source && ['keychain', 'vault', 'headless'].includes(mode),
  'Usage: node run-smoke.mjs <exact-version|local.tgz> <keychain|vault|headless> [posix|pwsh|cmd|direct]');
assert.ok(['posix', 'pwsh', 'cmd', 'direct'].includes(shell), 'Unknown shell');
const version = source.endsWith('.tgz') ? resolve(source) : source;
const cwd = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(cwd, 'logs'), {recursive: true});
const path = join(cwd, 'logs', `${process.platform}-${mode}-${shell}.log`);
writeFileSync(path, '');
let recent = '', lastOutput = Date.now(), done = false, timer;
let snapshot = {step:'driver startup', phase:'launch PTY driver', expected:promptPattern + ' OR STEP/subprocess completion', screen:'<no PTY screen received>'};
function output(data) {
  // Drivers emit only redacted screens or control metadata, never raw terminal chunks.
  const text = data.toString();
  appendFileSync(path, text); // Persist each progress line before a timeout/cancellation.
  process.stdout.write(text);
  recent = tail(recent + text);
}
output(`[RUN START] platform=${process.platform}; shell=${shell}; mode=${mode}\n`);
const flags = mode === 'keychain' ? [] : [mode === 'headless' ? '--headless' : '--vault'];
const command = shell === 'posix' ? 'python3' : process.execPath;
const args = shell === 'posix' ? ['drive-pty.py', process.execPath, 'smoke.mjs', version, ...flags]
  : ['drive-conpty.mjs', shell === 'direct' ? '--direct' : shell, version, ...flags];
const waitMs = timeoutSetting('CTL_SMOKE_EXPECT_TIMEOUT_MS', 90_000);
const totalMs = timeoutSetting('CTL_SMOKE_TOTAL_TIMEOUT_MS', 540_000);
const silenceMs = shell === 'posix' ? totalMs : waitMs + 5000;
const started = Date.now();
const child = spawn(command, args, {cwd, env: process.env, detached: process.platform !== 'win32',
  stdio: shell === 'posix' ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc']});
child.on('message', message => {
  if (message?.type === 'diagnostic' && ['step','phase','expected','screen'].every(key => typeof message[key] === 'string')) snapshot = message;
});
async function abort(reason) {
  if (done) return;
  done = true;
  clearInterval(timer);
  output(`[SUPERVISOR FAIL] ${reason}; STEP=${snapshot.step}; phase=${snapshot.phase}\n[EXPECT] ${snapshot.expected}\n[SCREEN last redacted snapshot <=2048 bytes]\n${snapshot.screen}\nLast redacted driver output (<=2048 bytes):\n${recent}\n`);
  if (process.platform === 'win32' && child.pid) {
    await new Promise(resolveKill => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {stdio: 'ignore', windowsHide: true});
      const deadline = setTimeout(() => { killer.kill(); resolveKill(); }, 2000);
      killer.once('error', () => { clearTimeout(deadline); resolveKill(); });
      killer.once('close', () => { clearTimeout(deadline); resolveKill(); });
    });
  } else if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
  output('[RUN END] exit=1\n');
  process.stdout.write('', () => process.exit(1));
  setTimeout(() => process.exit(1), 200).unref();
}
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
  lastOutput = Date.now();
  output(data);
});
child.once('error', () => { void abort('unable to start PTY driver'); });
child.once('close', code => {
  if (done) return;
  done = true;
  clearInterval(timer);
  output(`[RUN END] exit=${code ?? 1}\n`);
  process.exitCode = code ?? 1;
});
timer = setInterval(() => {
  if (Date.now() - started >= totalMs) void abort(`total limit ${totalMs}ms exceeded`);
  else if (Date.now() - lastOutput >= silenceMs) void abort(`driver silent for ${silenceMs}ms; native spawn/exit may be blocked`);
}, 100);
process.once('SIGTERM', () => void abort('received SIGTERM'));
process.once('SIGINT', () => void abort('received SIGINT'));
