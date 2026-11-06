// No raw PTY data may reach a log before this redactor has seen the control state.
import {stripVTControlCharacters} from 'node:util';

const literals = [
  'Enter a new token now? [y/N]',
  'Open the credential page in your browser? [y/N]',
  'Native API token (hidden):', 'Native API password (hidden):',
  'Native account name:', 'Independent vault passphrase (hidden):',
  'Confirm vault passphrase (hidden):', 'Native vault passphrase (hidden):',
  'Store this App credential locally? [y/N]',
];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const promptPattern = literals.map(value => escape(value).replaceAll(' ', '[ \\t\\r\\n]+')).join('|');
export const newPromptRegex = () => new RegExp(promptPattern, 'g');
export const plain = value => stripVTControlCharacters(value).replace(/\r\n?/g, '\n');
const fixtures = ['synthetic-dsm-password', 'smoke-dsm-session', 'smoke-dsm-token',
  'wrong-smoke-token', 'wrong-smoke-password'];

export function redact(raw, states = []) {
  let text = plain(raw), leaked = false;
  const secrets = new Set(fixtures);
  for (const state of states) {
    if (state.secret) secrets.add(state.secret);
    if (state.passphrase) secrets.add(state.passphrase);
  }
  for (const value of secrets) {
    // ConPTY may wrap a value or split it with CRLF/ANSI repaint sequences.
    const pattern = new RegExp([...value].map(escape).join('[\\r\\n]*'), 'g');
    if (pattern.test(text)) { leaked = true; text = text.replace(pattern, '[REDACTED]'); }
    // Also quarantine a partially echoed secret at the end of a timeout screen.
    for (let length = value.length - 1; length >= 8; length--) {
      if (text.endsWith(value.slice(0, length))) {
        leaked = true;
        text = text.slice(0, -length) + '[REDACTED PARTIAL]';
        break;
      }
    }
  }
  const tokens = /smoke-[0-9a-f]{16}-[\w-]+/g;
  if (tokens.test(text)) { leaked = true; text = text.replace(tokens, '[REDACTED]'); }
  for (const {root} of states) {
    if (!root) continue;
    for (const value of [root, encodeURI(root), root.replaceAll('\\', '\\\\')]) {
      text = text.replaceAll(value, '<temporary-directory>');
    }
  }
  return {text, leaked};
}
export function tail(text) {
  // Redact first, then truncate: never expose a suffix of a longer secret.
  return Buffer.from(text).subarray(-2048).toString('utf8');
}
export function timeoutSetting(name, fallback, max = fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < 100 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
