#!/usr/bin/env python3
"""Linux/macOS stdlib PTY driver. Keep raw output private until leak checks finish."""
import errno
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import sys
import tempfile
import time
from urllib.parse import quote

PROMPT = re.compile(
    r'Enter a new token now\? \[y/N\] |'
    r'Open the credential page in your browser\? \[y/N\] |'
    r'Native API token \(hidden\): |Native API password \(hidden\): |'
    r'Native account name: |Independent vault passphrase \(hidden\): |'
    r'Confirm vault passphrase \(hidden\): |Native vault passphrase \(hidden\): |'
    r'Store this App credential locally\? \[y/N\] '
)
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def answer(prompt, state):
    if prompt.startswith('Open '):
        return 'n'
    if prompt.startswith('Enter '):
        return 'n' if '401 decline' in state['label'] else 'y'
    if prompt.startswith('Native account'):
        return 'reader'
    if 'passphrase' in prompt:
        return state['passphrase']
    if prompt.startswith('Native API'):
        if not state.get('secret'):
            raise RuntimeError('Unexpected credential prompt')
        return state['secret']
    return 'y'


def main():
    if len(sys.argv) < 2:
        raise RuntimeError('Usage: python3 drive-pty.py <command> [args...]')
    with tempfile.TemporaryDirectory(prefix='ctl-driver-') as directory:
        control = Path(directory) / 'control.jsonl'
        control.touch(mode=0o600)
        pid, fd = pty.fork()
        if pid == 0:
            os.environ['CTL_SMOKE_CONTROL'] = str(control)
            os.execvp(sys.argv[1], sys.argv[1:])
        raw = b''
        offset = 0
        hidden = 0
        deadline = time.monotonic() + 600
        failure = None
        status = None
        try:
            while True:
                if time.monotonic() > deadline:
                    raise RuntimeError('PTY smoke timed out')
                ready, _, _ = select.select([fd], [], [], 1)
                if not ready:
                    ended, status_value = os.waitpid(pid, os.WNOHANG)
                    if ended:
                        status = status_value
                        break
                    continue
                try:
                    chunk = os.read(fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                raw += chunk
                text = ANSI.sub('', raw.decode(errors='replace'))
                while True:
                    match = PROMPT.search(text, offset)
                    if not match:
                        break
                    state = records(control)[-1]
                    value = answer(match[0], state)
                    hidden += '(hidden)' in match[0]
                    offset = match.end()
                    time.sleep(0.08)
                    os.write(fd, (value + '\n').encode())
        except BaseException as error:
            failure = type(error).__name__
            os.kill(pid, signal.SIGTERM)
        finally:
            os.close(fd)
            if status is None:
                _, status = os.waitpid(pid, 0)
        text = ANSI.sub('', raw.decode(errors='replace'))
        leaked = False
        for state in records(control):
            for value in (state.get('secret'), state.get('passphrase')):
                if value and value in text:
                    leaked = True
                    text = text.replace(value, '[REDACTED]')
            text = text.replace(state['root'], '<temporary-directory>')
            text = text.replace(quote(state['root'], safe='/'), '<temporary-directory>')
        # Include exchanged tokens and DSM fixtures never entered at a prompt.
        token_pattern = r'smoke-[0-9a-f]{16}-[\w-]+'
        leaked = leaked or bool(re.search(token_pattern, text))
        text = re.sub(token_pattern, '[REDACTED]', text)
        for value in ['synthetic-dsm-password', 'smoke-dsm-session', 'smoke-dsm-token',
                      'wrong-smoke-token', 'wrong-smoke-password']:
            if value in text:
                leaked = True
                text = text.replace(value, '[REDACTED]')
        text = re.sub(r'(?:/[^\s\r\n]+)*/ctl platform [^\r\n]*', '<temporary-path>', text)
        print(text, end='')
        code = os.waitstatus_to_exitcode(status)
        if leaked or failure or not hidden or 'ALL PLATFORM SMOKE CHECKS PASSED' not in text:
            print(f'FAIL PTY: echo={leaked}, driver={failure}, hidden-prompts={hidden}')
            return 1
        print(f'PASS PTY hidden-input assertions: {hidden}')
        return code


if __name__ == '__main__':
    sys.exit(main())
