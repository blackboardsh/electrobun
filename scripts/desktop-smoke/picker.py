"""Drive the actual Hutch init picker through a PTY, including the name prompt."""
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time

ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


def initialize(plan):
    command = [plan['hutch'], 'electrobun', 'init'] + (['--beta'] if plan['channel'] == 'beta' else [])
    if sys.platform == 'win32':
        from winpty import PtyProcess
        child = PtyProcess.spawn(subprocess.list2cmdline(command), cwd=plan['cwd'], env=dict(os.environ), dimensions=(40, 120))
    else:
        import pexpect
        child = pexpect.spawn(command[0], command[1:], cwd=plan['cwd'], env=dict(os.environ), encoding='utf-8', timeout=None, dimensions=(40, 120))
    messages = queue.Queue()

    def read():
        try:
            while True:
                chunk = child.read(4096) if sys.platform == 'win32' else child.read_nonblocking(4096, timeout=None)
                if not chunk:
                    break
                messages.put(chunk)
        except (EOFError, OSError):
            pass
        except Exception as error:
            # pexpect uses its own EOF exception.
            if error.__class__.__name__ != 'EOF':
                messages.put(error)
        finally:
            messages.put(None)

    threading.Thread(target=read, daemon=True).start()
    write = child.write if sys.platform == 'win32' else child.send
    transcript = ''
    selected = False
    named = False
    deadline = time.monotonic() + 900
    try:
        with open(plan['log'], 'w', encoding='utf-8') as log:
            while time.monotonic() < deadline:
                try:
                    chunk = messages.get(timeout=1)
                except queue.Empty:
                    continue
                if chunk is None:
                    break
                if isinstance(chunk, Exception):
                    raise chunk
                log.write(chunk)
                log.flush()
                transcript += chunk
                visible = ANSI.sub('', transcript)
                if not selected and f'Choose an Electrobun {plan["channel"]} template' in visible:
                    # Catalog order is the picker's order; each arrow is a real key.
                    for _ in range(plan['index']):
                        write('\x1b[B')
                        time.sleep(0.05)
                    write('\r')
                    selected = True
                if selected and not named and 'Project name [' in visible:
                    if f'Selected {plan["label"]}' not in visible:
                        raise AssertionError('Picker selected an unexpected template')
                    write(plan['projectName'] + '\r\n')
                    named = True
            else:
                raise TimeoutError('Interactive init exceeded 15 minutes')
        visible = ANSI.sub('', transcript)
        if not named or f'Downloading {plan["id"]} from Electrobun {plan["version"]}' not in visible:
            raise AssertionError('Init did not select the requested published template/version')
        if 'Created Electrobun project at ' not in visible:
            raise AssertionError('Interactive init did not finish successfully')
        if sys.platform != 'win32':
            child.close()
        code = child.exitstatus
        if code != 0:
            raise AssertionError(f'Interactive init exited with {code}')
    finally:
        if child.isalive():
            child.terminate(force=True)


if __name__ == '__main__':
    initialize(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
