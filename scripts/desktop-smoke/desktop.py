"""Desktop-level smoke checks. Never substitutes a DOM capture for visible pixels."""
import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def window(title):
    if sys.platform == 'darwin':
        import Quartz
        import AppKit
        for item in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0):
            if item.get('kCGWindowName') == title:
                bounds = item['kCGWindowBounds']
                AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(item['kCGWindowOwnerPID']).activateWithOptions_(3)
                return tuple(int(bounds[k]) for k in ('X', 'Y', 'Width', 'Height'))
    elif sys.platform == 'win32':
        from ctypes import wintypes
        user = ctypes.windll.user32
        user.SetProcessDPIAware()
        user.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
        user.FindWindowW.restype = wintypes.HWND
        user.IsWindowVisible.argtypes = [wintypes.HWND]
        user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user.SetForegroundWindow.argtypes = [wintypes.HWND]
        handle = user.FindWindowW(None, title)
        if handle and user.IsWindowVisible(handle):
            rect = wintypes.RECT()
            user.ShowWindow(handle, 9 if title == "Bunny" else 3)
            user.GetWindowRect(handle, ctypes.byref(rect))
            user.SetForegroundWindow(handle)
            return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top
    else:
        found = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '^' + re.escape(title) + '$'], capture_output=True, text=True)
        if found.returncode == 0:
            handle = found.stdout.splitlines()[-1]
            subprocess.run(['xdotool', 'windowactivate', '--sync', handle], check=True)
            geometry = subprocess.check_output(['xdotool', 'getwindowgeometry', '--shell', handle], text=True)
            values = dict(line.split('=', 1) for line in geometry.splitlines() if '=' in line)
            return tuple(int(values[k]) for k in ('X', 'Y', 'WIDTH', 'HEIGHT'))
    return None


def stop(process):
    if sys.platform == 'win32':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
    else:
        import signal
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=20)


def inspect_app(plan):
    import pyautogui as gui
    import pytesseract
    from PIL import ImageChops, ImageStat
    output = Path(plan['output'])
    output.mkdir(parents=True, exist_ok=True)
    if os.environ.get('SMOKE_TESSERACT'):
        pytesseract.pytesseract.tesseract_cmd = os.environ['SMOKE_TESSERACT']
    gui.PAUSE = 0.15
    shots = []
    checks = []
    result = {'name': plan['name'], 'ok': False, 'screenshots': shots, 'checks': checks}
    rect = None
    process = None

    def capture(label):
        image = gui.screenshot()
        image.save(output / f'{label}.png')
        shots.append(f'{label}.png')
        # Convert logical desktop coordinates to screenshot pixels (Retina).
        scale = image.width / gui.size().width
        x, y, w, h = rect
        box = tuple(round(n * scale) for n in (x, y, x + w, y + h))
        crop = image.crop(box)
        crop.save(output / f'{label}-window.png')
        return crop

    def text(image):
        return pytesseract.image_to_string(image, config='--psm 11')

    def await_text(expected, limit=45):
        deadline = time.monotonic() + limit
        last = ''
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f'app exited with {process.returncode}')
            image = gui.screenshot()
            scale = image.width / gui.size().width
            x, y, w, h = rect
            image = image.crop(tuple(round(n * scale) for n in (x, y, x+w, y+h)))
            last = text(image)
            if ' '.join(expected.casefold().split()) in ' '.join(last.casefold().split()):
                return image
            time.sleep(1)
        raise AssertionError(f'Visible text {expected!r} not found. Last OCR: {last}')

    def click_text(label):
        image = capture('target-' + re.sub(r'\W+', '-', label))
        data = pytesseract.image_to_data(image, config='--psm 11', output_type=pytesseract.Output.DICT)
        words = label.casefold().split()
        tokens = [word.casefold().strip() for word in data['text']]
        for start in range(len(tokens)):
            indices = []
            for i in range(start, len(tokens)):
                if tokens[i]:
                    indices.append(i)
                if len(''.join(tokens[j] for j in indices)) >= len(''.join(words)):
                    break
            if ''.join(tokens[i] for i in indices) == ''.join(words):
                first, last = indices[0], indices[-1]
                x = (data['left'][first] + data['left'][last] + data['width'][last]) / 2
                y = data['top'][first] + data['height'][first] / 2
                scale = gui.screenshot().width / gui.size().width
                gui.click(rect[0] + x / scale, rect[1] + y / scale)
                return
        raise AssertionError(f'Could not locate clickable text {label!r}: {tokens}')

    try:
        with (output / 'dev.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen(plan['command'], cwd=plan['cwd'], env={**os.environ, **plan.get('env', {})},
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=sys.platform != 'win32')
            deadline = time.monotonic() + plan.get('startupTimeout', 600)
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f'dev command exited with {process.returncode}')
                rect = window(plan['title'])
                if rect:
                    break
                time.sleep(1)
            if not rect:
                raise AssertionError(f'No visible window titled {plan["title"]!r}')
            checks.append('visible-window')
            gui.moveTo(max(2, rect[0] - 20), max(2, rect[1] - 20))
            if plan.get('readyText'):
                await_text(plan['readyText'])
                checks.append('rendered-ready-text')
            time.sleep(2)
            before = capture('01-rendered')
            if max(ImageStat.Stat(before.convert('RGB')).stddev) < 5:
                raise AssertionError('Window capture is blank or nearly uniform')
            checks.append('nonblank-desktop-capture')
            for index, action in enumerate(plan['actions']):
                if 'click' in action:
                    click_text(action['click'])
                if 'clickAt' in action:
                    x, y = action['clickAt']
                    gui.click(rect[0] + rect[2] * x, rect[1] + rect[3] * y)
                if 'key' in action:
                    gui.press(action['key'])
                if 'move' in action:
                    x, y = action['move']
                    gui.moveTo(rect[0] + rect[2] * x, rect[1] + rect[3] * y, duration=0.3)
                if 'expectText' in action:
                    await_text(action['expectText'])
                    checks.append('visible-text:' + action['expectText'])
                if 'expectCounter' in action:
                    frame = capture('counter-check')
                    counter = frame.crop((round(frame.width * 0.1), round(frame.height * 0.28), round(frame.width * 0.5), round(frame.height * 0.55)))
                    observed = pytesseract.image_to_string(counter, config='--psm 6 -c tessedit_char_whitelist=0123456789').strip()
                    if observed != str(action['expectCounter']):
                        raise AssertionError(f'Expected visible counter {action["expectCounter"]}, read {observed!r}')
                    checks.append('visible-counter:' + observed)
                if 'absentText' in action:
                    time.sleep(1)
                    observed = ' '.join(text(capture('absence-check')).casefold().split())
                    if action['absentText'].casefold() in observed:
                        raise AssertionError(f'Text should be occluded: {action["absentText"]}')
                    checks.append('occluded-text:' + action['absentText'])
                time.sleep(action.get('settle', 1))
                after = capture(f'{index + 2:02d}-interaction')
                if action.get('expectChange'):
                    difference = ImageStat.Stat(ImageChops.difference(before.convert('RGB'), after.convert('RGB')))
                    if max(difference.mean) < 0.1:
                        raise AssertionError('Input did not produce a visible change')
                    checks.append('visible-response-to-input')
                before = after
            if process.poll() is not None:
                raise RuntimeError('App exited during interaction')
            result['ok'] = True
    except Exception as error:
        result['error'] = str(error)
        try:
            gui.screenshot().save(output / 'failure.png')
            shots.append('failure.png')
        except Exception as capture_error:
            result['captureError'] = str(capture_error)
        raise
    finally:
        (output / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        if process:
            stop(process)


if __name__ == '__main__':
    inspect_app(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
