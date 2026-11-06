// One entry point for hosted runners; only sanitized PTY output becomes an artifact.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, createWriteStream} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const [source, mode = 'keychain', shell = 'posix'] = process.argv.slice(2);
assert.ok(source && ['keychain', 'vault', 'headless'].includes(mode),
  'Usage: node run-smoke.mjs <exact-version|local.tgz> <keychain|vault|headless> [posix|pwsh|cmd|direct]');
assert.ok(['posix', 'pwsh', 'cmd', 'direct'].includes(shell), 'Unknown shell');
const version = source.endsWith('.tgz') ? resolve(source) : source;
const cwd = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(cwd, 'logs'), {recursive: true});
const log = createWriteStream(join(cwd, 'logs', `${process.platform}-${mode}-${shell}.log`));
const flags = mode === 'keychain' ? [] : [mode === 'headless' ? '--headless' : '--vault'];
const command = shell === 'posix' ? 'python3' : process.execPath;
const args = shell === 'posix' ? ['drive-pty.py', process.execPath, 'smoke.mjs', version, ...flags]
  : ['drive-conpty.mjs', shell === 'direct' ? '--direct' : shell, version, ...flags];
const child = spawn(command, args, {cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
  log.write(data);
  process.stdout.write(data);
});
child.once('error', () => { console.error('Unable to start PTY driver'); process.exitCode = 1; log.end(); });
child.once('close', code => { process.exitCode = code ?? 1; log.end(); });
