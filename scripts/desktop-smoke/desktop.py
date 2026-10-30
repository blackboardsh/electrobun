"""Desktop-level smoke checks. Never substitutes a DOM capture for visible pixels."""
import ctypes
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def diagnostic_error(result, label, error):
    result.setdefault('diagnosticErrors', []).append({'label': label, 'error': str(error)})


def windows_find_window(title):
    """Find the diagnostic candidate once, without activation or geometry changes."""
    from ctypes import wintypes
    user = ctypes.windll.user32
    user.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user.FindWindowW.restype = wintypes.HWND
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowThreadProcessId.restype = wintypes.DWORD
    handle = user.FindWindowW(None, title)
    pid = wintypes.DWORD()
    if handle:
        user.GetWindowThreadProcessId(handle, ctypes.byref(pid))
    return int(handle or 0), pid.value


def windows_process_ancestry(pid, root_pid):
    """Prove ownership from one bounded, read-only snapshot after the outcome."""
    from ctypes import wintypes

    class ProcessEntry(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                    ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_size_t),
                    ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                    ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG),
                    ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260)]

    kernel = ctypes.windll.kernel32
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    for name in ('Process32FirstW', 'Process32NextW'):
        function = getattr(kernel, name)
        function.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
        function.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    snapshot = kernel.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    if snapshot in (None, ctypes.c_void_p(-1).value):
        raise OSError('Could not snapshot Windows process ownership')
    parents, processes = {}, {}
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        available = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        for _ in range(4096):
            if not available:
                break
            parents[entry.th32ProcessID] = entry.th32ParentProcessID
            processes[entry.th32ProcessID] = {'pid': entry.th32ProcessID,
                                             'parentPid': entry.th32ParentProcessID,
                                             'executable': entry.szExeFile}
            available = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    children = {}
    for process_pid, parent_pid in parents.items():
        children.setdefault(parent_pid, []).append(process_pid)
    owned, pending = set(), [root_pid]
    while pending and len(owned) < 4096:
        current = pending.pop()
        if current in owned:
            continue
        owned.add(current)
        pending.extend(children.get(current, []))
    ownership = {'verified': False, 'windowPid': pid, 'rootPid': root_pid,
                 'snapshotProcesses': len(parents), 'snapshotTruncated': bool(available),
                 'ownedProcesses': [processes[owned_pid] for owned_pid in sorted(owned) if owned_pid in processes]}
    chain, current = [], pid
    while current and current not in chain and len(chain) < 64:
        chain.append(current)
        if current == root_pid:
            ownership.update(verified=True, chain=chain)
            return ownership
        current = parents.get(current)
    ownership['chain'] = chain
    return ownership


def windows_class_threads(pid, parent, class_name):
    """Read a bounded set of same-process window owners without messages."""
    from ctypes import wintypes
    user = ctypes.windll.user32
    user.FindWindowExW.argtypes = [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR]
    user.FindWindowExW.restype = wintypes.HWND
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowThreadProcessId.restype = wintypes.DWORD
    previous, seen, windows = 0, set(), []
    truncated, cycle = False, False
    for _ in range(64):
        handle = int(user.FindWindowExW(wintypes.HWND(parent), previous, class_name, None) or 0)
        if not handle:
            break
        if handle in seen:
            truncated, cycle = True, True
            break
        seen.add(handle)
        owner = wintypes.DWORD()
        thread_id = user.GetWindowThreadProcessId(handle, ctypes.byref(owner))
        if owner.value == pid:
            windows.append({'hwnd': handle, 'pid': owner.value, 'threadId': thread_id, 'className': class_name})
        previous = handle
    else:
        truncated = True
    return {'windows': windows, 'windowsExamined': len(seen), 'truncated': truncated, 'cycleDetected': cycle}


def windows_dispatcher_threads(pid, window_thread_id):
    """MessageWindowClass is created by the native startEventLoop dispatcher."""
    snapshot = windows_class_threads(pid, -3, 'MessageWindowClass')  # HWND_MESSAGE
    dispatchers = snapshot.pop('windows')
    return {**snapshot, 'windowThreadId': window_thread_id, 'dispatchers': dispatchers,
            'windowThreadMatchesDispatcher': any(item['threadId'] == window_thread_id for item in dispatchers)
            if dispatchers else None}


def windows_child_threads(pid, window_thread_id, handle):
    """Read only direct ContainerViewClass children of the verified Bunny HWND."""
    snapshot = windows_class_threads(pid, handle, 'ContainerViewClass')
    children = snapshot.pop('windows')
    return {**snapshot, 'parentHwnd': handle, 'windowThreadId': window_thread_id,
            'children': children, 'childFound': bool(children),
            'allChildrenMatchWindowThread': all(item['threadId'] == window_thread_id for item in children)
            if children else None}


def windows_thread_snapshot(pid, window_thread_id):
    """Bound the passive thread snapshot; earliest creation is only an inference."""
    script = r"""
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id __PROCESS_ID__ -ErrorAction Stop
$allThreads = $process.Threads
$threads = @($allThreads | Select-Object -First 256 | ForEach-Object {
    $entry = [ordered]@{ threadId = $_.Id; startTimeUtc = $null }
    try { $entry.startTimeUtc = $_.StartTime.ToUniversalTime().ToString('o') }
    catch { $entry.error = $_.Exception.Message }
    [pscustomobject]$entry
})
[ordered]@{
    pid = $process.Id
    processStartTimeUtc = $process.StartTime.ToUniversalTime().ToString('o')
    totalThreads = $allThreads.Count
    truncated = ($allThreads.Count -gt 256)
    threads = $threads
} | ConvertTo-Json -Depth 4 -Compress
""".replace('__PROCESS_ID__', str(int(pid)))
    completed = subprocess.run(['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
                               capture_output=True, text=True, check=True, timeout=3,
                               creationflags=0x08000000)  # CREATE_NO_WINDOW: preserve desktop state
    snapshot = json.loads(completed.stdout)
    if not isinstance(snapshot, dict) or snapshot.get('pid') != pid or not isinstance(snapshot.get('threads'), list):
        raise RuntimeError('Unexpected Windows process thread snapshot')
    dated = [thread for thread in snapshot['threads'] if thread.get('startTimeUtc')]
    earliest = min(dated, key=lambda thread: thread['startTimeUtc']) if dated else None
    snapshot.update(windowThreadId=window_thread_id,
                    earliestObservedThreadId=earliest['threadId'] if earliest else None,
                    windowThreadMatchesEarliestObserved=window_thread_id == earliest['threadId'] if earliest else None,
                    inference='Earliest observed creation time is only a candidate for the main thread; '
                              'missing or terminated threads can change that inference.')
    return snapshot


def windows_window_state(handle):
    """Read the desktop state without activating, moving, or replacing the HWND."""
    from ctypes import wintypes
    user = ctypes.windll.user32
    signatures = {
        'IsWindow': ([wintypes.HWND], wintypes.BOOL),
        'IsWindowVisible': ([wintypes.HWND], wintypes.BOOL),
        'GetWindowRect': ([wintypes.HWND, ctypes.POINTER(wintypes.RECT)], wintypes.BOOL),
        'GetWindowThreadProcessId': ([wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
        'GetForegroundWindow': ([], wintypes.HWND),
        'GetWindow': ([wintypes.HWND, wintypes.UINT], wintypes.HWND),
        'WindowFromPoint': ([wintypes.POINT], wintypes.HWND),
        'GetAncestor': ([wintypes.HWND, wintypes.UINT], wintypes.HWND),
        'GetWindowLongPtrW': ([wintypes.HWND, ctypes.c_int], ctypes.c_ssize_t),
        'GetLayeredWindowAttributes': ([wintypes.HWND, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(ctypes.c_ubyte), ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
        'GetWindowDisplayAffinity': ([wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
    }
    for name, (args, returns) in signatures.items():
        function = getattr(user, name)
        function.argtypes, function.restype = args, returns

    def details(hwnd):
        pid, rect = wintypes.DWORD(), wintypes.RECT()
        thread = user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        rect_ok = user.GetWindowRect(hwnd, ctypes.byref(rect))
        extended = user.GetWindowLongPtrW(hwnd, -20) & 0xffffffff  # GWL_EXSTYLE
        return {'hwnd': int(hwnd or 0), 'pid': pid.value, 'threadId': thread,
                'isWindow': bool(user.IsWindow(hwnd)), 'visible': bool(user.IsWindowVisible(hwnd)),
                'style': user.GetWindowLongPtrW(hwnd, -16) & 0xffffffff, 'extendedStyle': extended,
                'topmost': bool(extended & 0x00000008),
                'bounds': [rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top] if rect_ok else None,
                'getWindowRectReturn': rect_ok, 'getWindowThreadProcessIdReturn': thread}

    state = details(handle)
    color, alpha, flags, affinity = wintypes.DWORD(), ctypes.c_ubyte(), wintypes.DWORD(), wintypes.DWORD()
    layered_ok = user.GetLayeredWindowAttributes(handle, ctypes.byref(color), ctypes.byref(alpha), ctypes.byref(flags))
    affinity_ok = user.GetWindowDisplayAffinity(handle, ctypes.byref(affinity))
    state['layeredWindowAttributes'] = {'return': layered_ok, 'colorKey': color.value if layered_ok else None,
                                        'alpha': alpha.value if layered_ok else None, 'flags': flags.value if layered_ok else None}
    state['displayAffinity'] = {'return': affinity_ok, 'value': affinity.value if affinity_ok else None}
    foreground = user.GetForegroundWindow()
    state['foregroundHwnd'] = int(foreground or 0)
    state['foreground'] = details(foreground) if foreground else None
    state['isForeground'] = bool(handle and handle == foreground)
    state['occlusionCandidates'] = []
    if state['bounds'] and state['isWindow']:
        x, y, width, height = state['bounds']
        center = wintypes.POINT(x + width // 2, y + height // 2)
        hit = user.WindowFromPoint(center)
        state['center'] = [center.x, center.y]
        state['windowFromPointHwnd'] = int(hit or 0)
        state['windowFromPointRootHwnd'] = int(user.GetAncestor(hit, 2) or 0) if hit else 0
        state['windowFromPoint'] = details(hit) if hit else None
        # GW_HWNDPREV walks toward the front of the Z order. These are only
        # geometric candidates; transparency/regions can prevent occlusion.
        previous, seen = user.GetWindow(handle, 3), {handle}
        examined = 0
        while previous and previous not in seen and examined < 32:
            seen.add(previous)
            examined += 1
            candidate = details(previous)
            if candidate['visible'] and candidate['bounds']:
                cx, cy, cw, ch = candidate['bounds']
                if cx < x + width and cx + cw > x and cy < y + height and cy + ch > y:
                    candidate['coversCenter'] = cx <= center.x < cx + cw and cy <= center.y < cy + ch
                    state['occlusionCandidates'].append(candidate)
            previous = user.GetWindow(previous, 3)
        state['zOrderWindowsExamined'] = examined
        state['zOrderTruncated'] = bool(previous and examined == 32)
    return state


class WindowsWindowDiagnostics:
    def __init__(self, output, result):
        self.output, self.result = output, result
        self.handle = None
        self.pid = None

    def record(self, label, handle, activation=None):
        try:
            state = windows_window_state(handle)
            if self.handle is None and state['isWindow'] and state['visible']:
                self.handle, self.pid = handle, state['pid']
            observation = {'label': label, 'time': time.time(), **state}
            if activation is not None:
                observation['activationReturns'] = activation
            if self.handle is not None:
                observation['originalHwnd'] = int(self.handle)
                observation['originalPid'] = self.pid
                observation['sameOriginalWindow'] = handle == self.handle and state['pid'] == self.pid
            self.result.setdefault('windowReadings', []).append(observation)
            with (self.output / 'window-diagnostics.jsonl').open('a', encoding='utf-8') as log:
                log.write(json.dumps(observation) + '\n')
            return observation
        except Exception as error:
            diagnostic_error(self.result, label, error)
            return None

    def record_pointer(self, gui, label):
        try:
            observation = {'label': label, 'time': time.time(), 'actual': list(gui.position())}
            self.result.setdefault('pointerReadings', []).append(observation)
            with (self.output / 'pointer-diagnostics.jsonl').open('a', encoding='utf-8') as log:
                log.write(json.dumps(observation) + '\n')
        except Exception as error:
            diagnostic_error(self.result, 'pointer:' + label, error)

    def after_failure(self, gui, shots, samples=3, observe_pointer=False, deadline=None):
        # Called only after the original exception and failed result are fixed.
        # Never rerun an assertion or activate/re-find a window by its title.
        if self.handle is None:
            return
        for sample in range(1, samples + 1):
            if deadline is not None and time.monotonic() + 1 > deadline:
                break
            label = f'failure-later-{sample:02d}'
            try:
                time.sleep(1)
                if deadline is not None and time.monotonic() >= deadline:
                    break
                state = self.record(label, self.handle)
                if observe_pointer:
                    self.record_pointer(gui, label)
                image = gui.screenshot()
                image.save(self.output / f'{label}.png')
                shots.append(f'{label}.png')
                if state and state['sameOriginalWindow'] and state['isWindow'] and state['bounds']:
                    scale = image.width / gui.size().width
                    x, y, width, height = state['bounds']
                    image.crop(tuple(round(n * scale) for n in (x, y, x + width, y + height))).save(
                        self.output / f'{label}-window.png')
            except Exception as error:
                diagnostic_error(self.result, label, error)


def native_only_after_outcome(plan, output, result, process, gui, shots):
    """Observe original app bytes only after the original assertion result is fixed."""
    if not plan.get('nativeOnlyDiagnostics') or sys.platform != 'win32':
        return
    try:
        if not result.get('ok') and 'error' not in result:
            raise RuntimeError('Native-only diagnostics require a completed original outcome')
        outcome = 'passed' if result['ok'] else 'failed'
        metadata = {'outcome': outcome, 'initializedAfterOutcome': True,
                    'maximumLaterSamples': 0 if result['ok'] else 10,
                    'maximumLaterObservationSeconds': 0 if result['ok'] else 15}
        result['nativeOnlyDiagnostics'] = metadata
        diagnostics = WindowsWindowDiagnostics(output, result)
        diagnostics.record_pointer(gui, 'native-only-' + outcome)
        handle, pid = windows_find_window(plan['title'])
        metadata['candidateHwnd'], metadata['candidatePid'] = handle, pid
        if not handle or not pid or process is None:
            raise RuntimeError('No diagnostic window with a verifiable launched process')
        ownership = windows_process_ancestry(pid, process.pid)
        metadata['processOwnership'] = ownership
        if not ownership['verified']:
            raise RuntimeError('Diagnostic window PID is not a verified app descendant')
        # Pin the verified pair before reading state; a reused HWND must never
        # become the new original window, even during the first observation.
        diagnostics.handle, diagnostics.pid = handle, pid
        state = diagnostics.record('native-only-' + outcome, handle)
        if state is None or not state['sameOriginalWindow'] or not state['isWindow']:
            raise RuntimeError('Diagnostic window identity changed after discovery')
        for key, reader, arguments in (
                ('dispatcherThreads', windows_dispatcher_threads, (pid, state['threadId'])),
                ('childThreads', windows_child_threads, (pid, state['threadId'], handle)),
                ('processThreads', windows_thread_snapshot, (pid, state['threadId']))):
            try:
                metadata[key] = reader(*arguments)
            except Exception as error:
                diagnostic_error(result, 'native-only-' + key, error)
        if not result['ok']:
            diagnostics.after_failure(gui, shots, samples=10, observe_pointer=True,
                                      deadline=time.monotonic() + 15)
    except Exception as error:
        diagnostic_error(result, 'native-only-post-outcome', error)


def window(title, activate=True, diagnostics=None):
    if sys.platform == 'darwin':
        import Quartz
        import AppKit
        for item in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, 0):
            if item.get('kCGWindowName') == title:
                bounds = item['kCGWindowBounds']
                if activate:
                    AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(item['kCGWindowOwnerPID']).activateWithOptions_(2)
                return tuple(int(bounds[k]) for k in ('X', 'Y', 'Width', 'Height'))
    elif sys.platform == 'win32':
        from ctypes import wintypes
        user = ctypes.windll.user32
        dpi_return = user.SetProcessDPIAware()
        user.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
        user.FindWindowW.restype = wintypes.HWND
        user.IsWindowVisible.argtypes = [wintypes.HWND]
        user.IsWindowVisible.restype = wintypes.BOOL
        user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        user.GetWindowRect.restype = wintypes.BOOL
        user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user.ShowWindow.restype = wintypes.BOOL
        user.SetForegroundWindow.argtypes = [wintypes.HWND]
        user.SetForegroundWindow.restype = wintypes.BOOL
        user.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                     ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        user.SetWindowPos.restype = wintypes.BOOL
        handle = user.FindWindowW(None, title)
        if handle and user.IsWindowVisible(handle):
            rect = wintypes.RECT()
            returns = {'SetProcessDPIAware': dpi_return}
            if activate:
                # ShowWindow returns the previous visibility, not success.
                returns['ShowWindowPreviousVisibility'] = user.ShowWindow(handle, 9 if title == "Bunny" or title.startswith("Electrobun UI") else 3)
            returns['GetWindowRect'] = user.GetWindowRect(handle, ctypes.byref(rect))
            if activate:
                # Hosted ARM runners can open background console windows after
                # startup. Keep the app under test above them for actual input
                # and screenshots; the process teardown removes this window.
                returns['SetWindowPos'] = user.SetWindowPos(handle, wintypes.HWND(-1), 0, 0, 0, 0, 0x0001 | 0x0002)
                returns['SetForegroundWindow'] = user.SetForegroundWindow(handle)
            if diagnostics is not None:
                diagnostics.record('activation' if activate else 'observation', handle, returns if activate else None)
            return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top
        if diagnostics is not None:
            diagnostics.record('window-not-visible', handle)
    else:
        found = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '^' + re.escape(title) + '$'], capture_output=True, text=True)
        if found.returncode == 0:
            handle = found.stdout.splitlines()[-1]
            if activate:
                subprocess.run(['xdotool', 'windowactivate', '--sync', handle], check=True)
            geometry = subprocess.check_output(['xdotool', 'getwindowgeometry', '--shell', handle], text=True)
            values = dict(line.split('=', 1) for line in geometry.splitlines() if '=' in line)
            return tuple(int(values[k]) for k in ('X', 'Y', 'WIDTH', 'HEIGHT'))
    return None


def minimize_window(gui, title):
    bounds = window(title)
    if not bounds:
        return False
    if sys.platform == 'win32':
        user = ctypes.windll.user32
        user.ShowWindow(user.FindWindowW(None, title), 6)
    elif sys.platform == 'darwin':
        # Standard Cocoa titlebar's yellow button. Do this as soon as the
        # runner opens, before its delayed interactive playground starts.
        gui.click(bounds[0] + 34, bounds[1] + 14)
    else:
        handle = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--name',
                                          '^' + re.escape(title) + '$'], text=True).splitlines()[-1]
        subprocess.run(['xdotool', 'windowminimize', handle], check=True)
    return True


def stop(process):
    if sys.platform == 'win32':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
    else:
        import signal
        try:
            # The Kitchen matrix owns detached app groups and forwards SIGTERM
            # to them. SIGKILL would strand CEF and lock its profile for the next app.
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=20)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=20)


def rendered_surface(frame, region):
    from PIL import ImageStat
    box = tuple(round(value * (frame.width if i % 2 == 0 else frame.height))
                for i, value in enumerate(region))
    return max(ImageStat.Stat(frame.crop(box).convert('RGB')).stddev) >= 10


def bunny_rendered(frame, reference):
    """Match the published Bunny silhouette, not pixels behind its transparent window."""
    from PIL import Image, ImageChops

    def components(image):
        image = image.convert('RGBA')
        pixels = image.load()
        remaining = {(x, y) for y in range(image.height) for x in range(image.width)
                     if min(pixels[x, y][:3]) >= 200 and
                     max(pixels[x, y][:3]) - min(pixels[x, y][:3]) <= 35 and pixels[x, y][3] >= 200}
        found = []
        while remaining:
            seed = remaining.pop()
            component, pending = {seed}, [seed]
            while pending:
                x, y = pending.pop()
                # Diagonal antialiasing pixels must not connect the small
                # rabbit body to a white desktop behind the transparent view.
                for point in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if point in remaining:
                        remaining.remove(point)
                        component.add(point)
                        pending.append(point)
            xs, ys = zip(*component)
            found.append((component, (min(xs), min(ys), max(xs) + 1, max(ys) + 1)))
        return sorted(found, key=lambda entry: len(entry[0]), reverse=True)

    def silhouette(component, box):
        left, top, right, bottom = box
        mask = Image.new('L', (right - left, bottom - top))
        for x, y in component:
            mask.putpixel((x - left, y - top), 255)
        return mask.resize((64, 96), Image.Resampling.NEAREST)

    def has_eye(component, box):
        left, top, right, bottom = box
        remaining = {(x, y) for y in range(top, bottom) for x in range(left, right)
                     if (x, y) not in component}
        while remaining:
            seed = remaining.pop()
            hole, pending, touches_edge = {seed}, [seed], False
            while pending:
                x, y = pending.pop()
                touches_edge |= x in (left, right - 1) or y in (top, bottom - 1)
                for point in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if point in remaining:
                        remaining.remove(point)
                        hole.add(point)
                        pending.append(point)
            if touches_edge:
                continue
            xs, ys = zip(*hole)
            x = ((min(xs) + max(xs)) / 2 - left) / (right - left)
            y = ((min(ys) + max(ys)) / 2 - top) / (bottom - top)
            # The enclosed eye distinguishes the known rabbit from bright
            # punctuation and simple shapes with a similar overall outline.
            if 0.15 <= x <= 0.40 and 0.30 <= y <= 0.60 and 0.005 <= len(hole) / len(component) <= 0.12:
                return True
        return False

    reference_components = components(reference)
    if not reference_components:
        raise ValueError('Bunny readiness reference has no visible silhouette')
    expected = silhouette(*reference_components[0])
    width, height = frame.size
    for component, box in components(frame):
        left, top, right, bottom = box
        # The published image is 50vmin. Its solid body occupies only part of
        # that square. Ignore the Linux white background and terminal glyphs.
        if left == 0 or top == 0 or right == width or bottom == height:
            continue
        if not (0.008 <= len(component) / (width * height) <= 0.07 and
                0.12 <= (right - left) / width <= 0.35 and
                0.22 <= (bottom - top) / height <= 0.42):
            continue
        observed = silhouette(component, box)
        intersection = sum(ImageChops.darker(expected, observed).getdata())
        union = sum(ImageChops.lighter(expected, observed).getdata())
        if union and intersection / union >= 0.45 and has_eye(component, box):
            return True
    return False


def counter_region(frame):
    return frame.crop((round(frame.width * 0.15), round(frame.height * 0.25),
                       round(frame.width * 0.45), round(frame.height * 0.55))).convert('RGB')


def counter_glyph(frame):
    from PIL import Image
    # The remote webview can change layout height after startup. Compare the
    # counter's silhouette independently of its position, leaving labels and
    # the hover border of the button outside the largest accent component.
    frame = frame.convert('RGB')
    pixels = frame.load()
    remaining = {(x, y) for y in range(frame.height) for x in range(frame.width)
                 if (lambda r, g, b: b > r + 20 and r > g + 20 and b > 110)(*pixels[x, y])}
    largest = set()
    while remaining:
        seed = remaining.pop()
        component, pending = {seed}, [seed]
        while pending:
            x, y = pending.pop()
            for point in ((x-1, y), (x+1, y), (x, y-1), (x, y+1)):
                if point in remaining:
                    remaining.remove(point)
                    component.add(point)
                    pending.append(point)
        if len(component) > len(largest):
            largest = component
    if len(largest) < 30:
        raise AssertionError('Counter glyph is missing or not rendered')
    mask = Image.new('L', frame.size)
    for point in largest:
        mask.putpixel(point, 255)
    return mask.crop(mask.getbbox()).resize((64, 96), Image.Resampling.NEAREST)


def counter_difference(initial, current):
    from PIL import ImageChops, ImageFilter, ImageStat
    before, after = counter_glyph(initial), counter_glyph(current)
    # Native fonts can move across a subpixel boundary after layout changes.
    # Ignore a one-pixel contour variation, but retain differences inside the
    # glyph (for example the empty center of 0 versus the stem of 1).
    extra = ImageChops.subtract(after, before.filter(ImageFilter.MaxFilter(3)))
    missing = ImageChops.subtract(before, after.filter(ImageFilter.MaxFilter(3)))
    return ImageStat.Stat(ImageChops.lighter(extra, missing)).mean[0]


def click_control(gui, point):
    gui.moveTo(*point)
    gui.mouseDown()
    try:
        # The native UI can poll mouse state once per render frame.
        time.sleep(0.15)
    finally:
        gui.mouseUp()


def scroll_host(gui, notches):
    # PyAutoGUI 0.9.54 forwards the value directly as mouse_event dwData on
    # Windows, where a wheel notch is WHEEL_DELTA (120), not one unit.
    # https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-mouse_event
    gui.scroll(notches * 120 if sys.platform == 'win32' else notches)


def double_click(gui, point):
    if sys.platform != 'darwin':
        gui.doubleClick(*point, interval=0.12)
        return
    # PyAutoGUI 0.9.54's macOS backend posts two independent single clicks.
    # Cocoa/CEF require the click-state field to identify the second click.
    import Quartz
    gui.moveTo(*point)
    for count in (1, 2):
        for event_type in (Quartz.kCGEventLeftMouseDown, Quartz.kCGEventLeftMouseUp):
            event = Quartz.CGEventCreateMouseEvent(None, event_type, point, Quartz.kCGMouseButtonLeft)
            Quartz.CGEventSetIntegerValueField(event, Quartz.kCGMouseEventClickState, count)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
            time.sleep(0.03)
        time.sleep(0.08)


def ocr_token(value):
    # Small antialiased labels can acquire leading quotation marks in OCR.
    # Preserve letters/digits so label matching remains exact.
    return value.casefold().strip().strip('.,;:!?\'"‘’“”')


def ocr_regions(image):
    from PIL import ImageOps
    yield image, 0, '--psm 11', 1, 0
    # Sparse-page OCR drops text inside filled buttons. Short overlapping
    # bands retain those labels without treating an animated GPU view as text.
    for top in range(0, image.height, 120):
        band = image.crop((0, top, image.width, min(top + 180, image.height)))
        yield band, top, '--psm 6', 1, 0
        # Filled buttons can disappear into the surrounding dark gradient in
        # Tesseract's adaptive threshold. Keep a fixed-contrast pass as well.
        yield band.convert('L').point(lambda value: 255 if value > 140 else 0), top, '--psm 6', 1, 0

    # Detect light button backgrounds, then OCR each label without unrelated
    # text or animated pixels. Work at quarter resolution to keep this cheap.
    small = image.convert('RGB').resize((max(1, image.width // 4), max(1, image.height // 4)))
    pixels = small.load()
    remaining = {(x, y) for y in range(small.height) for x in range(small.width)
                 if min(pixels[x, y]) > 120}
    while remaining:
        seed = remaining.pop()
        component, pending = [seed], [seed]
        while pending:
            x, y = pending.pop()
            for point in ((x-1, y), (x+1, y), (x, y-1), (x, y+1)):
                if point in remaining:
                    remaining.remove(point)
                    component.append(point)
                    pending.append(point)
        xs, ys = zip(*component)
        left, top, right, bottom = min(xs)*4, min(ys)*4, (max(xs)+1)*4, (max(ys)+1)*4
        if 35 <= right-left <= 300 and 18 <= bottom-top <= 100:
            left, top = left+2, top+2
            button = image.crop((left, top, right-2, bottom-2)).convert('L')
            button = ImageOps.expand(button, 10, fill=255)
            yield button.resize((button.width*2, button.height*2)), top-10, '--psm 7', 2, left-10


def app_failure(log_text):
    if 'Uncaught exception in worker:' in log_text:
        return 'App worker crashed; see dev.log'
    if 'has overflowed its stack' in log_text:
        return 'App stack overflow; see dev.log'
    if 'Child process exited with code:' in log_text:
        return 'App exited while the dev watcher was still running; see dev.log'
    return None


class TextObservationTimeout(AssertionError):
    pass


def normalized_text(value):
    return ''.join(value.casefold().split())


def image_has_text(image, expected, recognize, *, deadline, observation=None,
                   clock=None, regions=None):
    """Inspect one fixed image; incomplete OCR can never establish absence."""
    clock = clock or time.monotonic
    regions = regions or ocr_regions
    observation = observation if observation is not None else {}
    started = clock()
    observation.update(ocrPasses=0, ocrComplete=False, present=None)
    needle = normalized_text(expected)
    if not needle:
        raise ValueError('Expected text must not be empty')
    parts = []
    try:
        for region, _, config, _, _ in regions(image):
            remaining = deadline - clock()
            if remaining <= 0:
                raise TextObservationTimeout('Text OCR exceeded its analysis deadline')
            # pytesseract's timeout=0 means unbounded: never start a pass with
            # an exhausted budget. File preparation can also take time, so
            # check the clock again after the subprocess returns.
            observation['ocrPasses'] += 1
            parts.append(recognize(region, config=config, timeout=remaining))
            observation['ocrText'] = '\n'.join(parts)[-4096:]
            if clock() >= deadline:
                raise TextObservationTimeout('Text OCR exceeded its analysis deadline')
            if needle in normalized_text('\n'.join(parts)):
                observation['present'] = True
                return True
        if clock() >= deadline:
            raise TextObservationTimeout('Text OCR exceeded its analysis deadline')
        if not observation['ocrPasses']:
            raise RuntimeError('Text OCR produced no regions')
        observation.update(ocrComplete=True, present=False)
        return False
    except Exception as error:
        observation['ocrError'] = str(error)
        raise
    finally:
        observation['ocrElapsedSeconds'] = clock() - started


def observe_text(expected, capture, recognize, *, present=True, response_timeout=45,
                 analysis_timeout=120, interval=0.25, observation=None,
                 require_running=None, clock=None, sleep=None, regions=None):
    """Observe timely desktop frames; bound slow OCR separately from UI response.

    A frame must finish capture inside the response window. Its OCR may finish
    later, inside the analysis budget, and proves only what that saved frame
    showed. Neither an OCR error nor an image captured late can pass the check.
    All captures and OCR remain sequential on the caller's thread.
    """
    for name, value in (('response_timeout', response_timeout),
                        ('analysis_timeout', analysis_timeout), ('interval', interval)):
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f'{name} must be finite and positive')
    clock, sleep = clock or time.monotonic, sleep or time.sleep
    require_running = require_running or (lambda: None)
    observation = observation if observation is not None else {}
    started = clock()
    response_deadline, analysis_deadline = started + response_timeout, started + analysis_timeout
    samples = []
    observation.update(expected=expected, condition='present' if present else 'absent',
                       responseTimeoutSeconds=response_timeout, analysisTimeoutSeconds=analysis_timeout,
                       samples=samples, outcome='pending')

    def response_expired():
        requirement = f'Visible text {expected!r} not found' if present else f'Text should be occluded: {expected}'
        return TextObservationTimeout(f'{requirement} within the {response_timeout:g}-second capture deadline')

    try:
        while True:
            require_running()
            if clock() >= response_deadline:
                raise response_expired()
            if clock() >= analysis_deadline:
                raise TextObservationTimeout('Text observation exceeded its analysis deadline')
            sample = {'captureStartedSeconds': clock() - started, 'eligible': False}
            samples.append(sample)
            try:
                image = capture(sample)
            finally:
                sample['captureFinishedSeconds'] = clock() - started
            if clock() > response_deadline:
                raise response_expired()
            sample['eligible'] = True
            try:
                found = image_has_text(image, expected, recognize, deadline=analysis_deadline,
                                       observation=sample, clock=clock, regions=regions)
            finally:
                sample['analysisFinishedSeconds'] = clock() - started
            require_running()
            if clock() >= analysis_deadline:
                raise TextObservationTimeout('Text observation exceeded its analysis deadline')
            if found == present:
                observation.update(outcome='passed', matchedSample=len(samples) - 1,
                                   responseObservedSeconds=sample['captureFinishedSeconds'])
                return image
            remaining = response_deadline - clock()
            if remaining <= 0:
                raise response_expired()
            sleep(min(interval, remaining))
    except Exception as error:
        observation.update(outcome='failed', error=str(error))
        raise
    finally:
        observation['elapsedSeconds'] = clock() - started
        if samples:
            observation['initialScreenshot'] = samples[0].get('screenshot')
            observation['lastScreenshot'] = samples[-1].get('screenshot')


def inspect_app(plan):
    import pyautogui as gui
    import pytesseract
    from PIL import Image, ImageChops, ImageStat
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
    active_diagnostics = bool(plan.get('diagnostics')) and not plan.get('nativeOnlyDiagnostics')
    window_diagnostics = WindowsWindowDiagnostics(output, result) if active_diagnostics and sys.platform == 'win32' else None

    def record_pointer(label, requested=None):
        if active_diagnostics:
            try:
                observation = {'label': label, 'time': time.time(), 'actual': list(gui.position()),
                               'windowBounds': list(rect) if rect else None}
                if requested is not None:
                    observation['requested'] = list(requested)
                result.setdefault('pointerReadings', []).append(observation)
                with (output / 'pointer-diagnostics.jsonl').open('a', encoding='utf-8') as log:
                    log.write(json.dumps(observation) + '\n')
            except Exception as error:
                diagnostic_error(result, 'pointer:' + label, error)

    def require_running():
        if process.poll() is not None:
            raise RuntimeError(f'dev command exited with {process.returncode}')
        # Watch mode can survive a fatal exception in the launched app.
        log_text = (output / 'dev.log').read_text(encoding='utf-8', errors='replace')
        failure = app_failure(log_text)
        if failure:
            raise RuntimeError(failure)

    def refresh_bounds():
        nonlocal rect
        current = window(plan['title'], activate=False, diagnostics=window_diagnostics) if window_diagnostics else window(plan['title'], activate=False)
        if not current:
            raise AssertionError('App window is no longer visible')
        rect = current

    def capture(label):
        refresh_bounds()
        record_pointer('capture:' + label)
        image = gui.screenshot()
        label = f'{len(shots) + 1:02d}-{label}'
        image.save(output / f'{label}.png')
        shots.append(f'{label}.png')
        # Convert logical desktop coordinates to screenshot pixels (Retina).
        scale = image.width / gui.size().width
        x, y, w, h = rect
        box = tuple(round(n * scale) for n in (x, y, x + w, y + h))
        crop = image.crop(box)
        crop.save(output / f'{label}-window.png')
        return crop

    def await_text(expected, limit=45, present=True):
        observation = {'startedAtEpochSeconds': time.time()}
        result.setdefault('textObservations', []).append(observation)

        def capture_text(sample):
            image = capture('presence-check' if present else 'absence-check')
            sample['screenshot'] = shots[-1]
            sample['windowScreenshot'] = shots[-1].replace('.png', '-window.png')
            return image

        try:
            return observe_text(expected, capture_text, pytesseract.image_to_string,
                                present=present, response_timeout=limit, analysis_timeout=120,
                                observation=observation, require_running=require_running)
        finally:
            try:
                with (output / 'text-observations.jsonl').open('a', encoding='utf-8') as log:
                    log.write(json.dumps(observation) + '\n')
            except Exception as error:
                diagnostic_error(result, 'text-observation-evidence', error)

    def locate_text(label, image=None, occurrence="first"):
        candidates = []
        if image is None:
            image = capture('target-' + re.sub(r'\W+', '-', label))
        for region, top, config, ocr_scale, left in ocr_regions(image):
            data = pytesseract.image_to_data(region, config=config, output_type=pytesseract.Output.DICT)
            words = label.casefold().split()
            tokens = [ocr_token(word) for word in data['text']]
            for start in range(len(tokens)):
                indices = []
                for i in range(start, len(tokens)):
                    if tokens[i]:
                        indices.append(i)
                    if len(''.join(tokens[j] for j in indices)) >= len(''.join(words)):
                        break
                if ''.join(tokens[i] for i in indices) == ''.join(words):
                    first, last = indices[0], indices[-1]
                    x = left + (data['left'][first] + data['left'][last] + data['width'][last]) / (2 * ocr_scale)
                    y = top + (data['top'][first] + data['height'][first] / 2) / ocr_scale
                    scale = gui.screenshot().width / gui.size().width
                    point = (rect[0] + x / scale, rect[1] + y / scale)
                    if occurrence == "first":
                        return point
                    candidates.append(point)
        if candidates:
            return max(candidates, key=lambda point: point[1])
        raise AssertionError(f'Could not locate clickable text {label!r}: {tokens}')

    try:
        with (output / 'dev.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen(plan['command'], cwd=plan['cwd'], env={**os.environ, **plan.get('env', {})},
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=sys.platform != 'win32')
            sibling_minimized = not plan.get('minimizeWindow')
            deadline = time.monotonic() + plan.get('startupTimeout', 600)
            while time.monotonic() < deadline:
                require_running()
                if not sibling_minimized:
                    sibling_minimized = minimize_window(gui, plan['minimizeWindow'])
                    if not sibling_minimized:
                        time.sleep(0.1)
                        continue
                    checks.append('minimized-test-runner')
                rect = window(plan['title'], diagnostics=window_diagnostics) if window_diagnostics else window(plan['title'])
                if rect:
                    break
                time.sleep(1)
            if not rect:
                raise AssertionError(f'No visible window titled {plan["title"]!r}')
            checks.append('visible-window')
            # Maximize and the app's startup positioning can complete asynchronously.
            time.sleep(2)
            refresh_bounds()
            gui.moveTo(max(2, rect[0] - 20), max(2, rect[1] - 20))
            if plan.get('initialScrollHost'):
                await_text(plan['scrollReadyText'])
                # The right-hand host margin stays outside the 600px OOPIF.
                click_control(gui, (rect[0] + rect[2] * 0.9, rect[1] + rect[3] * 0.4))
                scroll_host(gui, plan['initialScrollHost'])
                time.sleep(1)
            if plan.get('readyText'):
                await_text(plan['readyText'])
                checks.append('rendered-ready-text')
            time.sleep(2)
            reference = None
            if plan.get('readyImage'):
                with Image.open(Path(plan['cwd']) / plan['readyImage']) as image:
                    reference = image.copy()
            render_deadline = time.monotonic() + 30
            while True:
                require_running()
                before = capture('rendered')
                visible = max(ImageStat.Stat(before.convert('RGB')).stddev) >= 5
                if plan.get('gpuRegion'):
                    visible = visible and rendered_surface(before, plan['gpuRegion'])
                if reference is not None:
                    visible = visible and bunny_rendered(before, reference)
                if visible:
                    break
                if time.monotonic() >= render_deadline:
                    if reference is not None:
                        raise AssertionError('Published Bunny image did not appear within the 30-second render deadline')
                    raise AssertionError('Window or required GPU surface remained blank or nearly uniform for 30 seconds')
                time.sleep(2)
            checks.append('nonblank-desktop-capture')
            if reference is not None:
                checks.append('rendered-bunny-image')
            if plan.get('gpuRegion'):
                checks.append('rendered-gpu-surface')
            initial_counter = counter_region(before)
            counter_changed = False
            result['windowBounds'] = list(rect)
            result['desktopSize'] = list(gui.size())
            last_click = None
            cursor_readings = []
            for index, action in enumerate(plan['actions']):
                refresh_bounds()
                if 'click' in action:
                    for label in [action['click'], *action.get('aliases', [])]:
                        try:
                            last_click = locate_text(label, occurrence=action.get('occurrence', 'first'))
                            break
                        except AssertionError:
                            if label == [action['click'], *action.get('aliases', [])][-1]:
                                raise
                    click_control(gui, last_click)
                if action.get('clickAgain'):
                    if last_click is None:
                        raise AssertionError('No previous control to click again')
                    click_control(gui, last_click)
                if 'doubleClick' in action:
                    point = locate_text(action['doubleClick'])
                    frame = capture('mask-before-selection')
                    scale = frame.width / rect[2]
                    x, y = (point[0] - rect[0]) * scale, (point[1] - rect[1]) * scale
                    box = tuple(round(v) for v in (x - 40 * scale, y - 14 * scale,
                                                  x + 40 * scale, y + 14 * scale))
                    def blue_coverage(image):
                        pixels = list(image.crop(box).convert('RGB').getdata())
                        return sum(b > r + 30 and b > 70 for r, g, b in pixels) / len(pixels)
                    baseline = blue_coverage(frame)
                    double_click(gui, point)
                    time.sleep(0.5)
                    selected = capture('mask-text-selected')
                    if blue_coverage(selected) - baseline < 0.08:
                        raise AssertionError('Double-click did not visibly highlight the mask text')
                    checks.append('mask-received-double-click:visible-selection')
                if 'scrollHost' in action:
                    # Track one host label and one embedded-page label. Both must
                    # move by the same distance; scrolling inside the OOPIF fails.
                    host = action['hostAnchor']
                    child = action['childAnchor']
                    frame = capture('before-host-scroll')
                    host_before = locate_text(host, frame)
                    child_before = locate_text(child, frame)
                    click_control(gui, host_before)
                    scroll_host(gui, action['scrollHost'])
                    time.sleep(2)
                    frame = capture('after-host-scroll')
                    host_after = locate_text(host, frame)
                    child_after = locate_text(child, frame)
                    host_delta = host_after[1] - host_before[1]
                    child_delta = child_after[1] - child_before[1]
                    if abs(host_delta) < 10 or host_delta * action['scrollHost'] <= 0:
                        raise AssertionError(f'Host did not scroll as requested: {host_delta}')
                    if abs(host_delta - child_delta) > 8 or abs(child_after[0] - child_before[0]) > 8:
                        raise AssertionError(f'OOPIF did not follow host: host={host_delta}, child={child_delta}')
                    checks.append(f'oopif-follows-host-scroll:host={host_delta:.1f},child={child_delta:.1f}')
                if 'clickAt' in action:
                    x, y = action['clickAt']
                    gui.click(rect[0] + rect[2] * x, rect[1] + rect[3] * y)
                if 'key' in action:
                    gui.press(action['key'])
                if 'move' in action:
                    x, y = action['move']
                    target = (rect[0] + rect[2] * x, rect[1] + rect[3] * y)
                    record_pointer('before-move', target)
                    gui.moveTo(*target, duration=0.3)
                    record_pointer('after-move', target)
                if 'expectText' in action:
                    await_text(action['expectText'])
                    checks.append('visible-text:' + action['expectText'])
                if action.get('expectCursor'):
                    deadline = time.monotonic() + 15
                    observed = None
                    previous_observed = None
                    while time.monotonic() < deadline:
                        frame = capture('cursor-check')
                        sidebar = frame.copy()
                        sidebar.paste((0, 0, 0), (0, 0, round(frame.width * 0.75), frame.height))
                        try:
                            cx, cy = locate_text('Cursor', sidebar)
                        except AssertionError:
                            time.sleep(1)
                            continue
                        scale = frame.width / rect[2]
                        left, top = (cx - rect[0]) * scale, (cy - rect[1]) * scale
                        readout = frame.crop((round(left - 45 * scale), round(top + 5 * scale),
                                              round(left + 150 * scale), round(top + 45 * scale)))
                        value = pytesseract.image_to_string(readout, config='--psm 6 -c tessedit_char_whitelist=0123456789,')
                        pair = re.search(r'(\d+)\s*,\s*(\d+)', value)
                        if pair:
                            observed = tuple(map(int, pair.groups()))
                            pointer = tuple(gui.position())
                            # The displayed value can lag the OS cursor while
                            # moveTo animates. Do not anchor the delta to an
                            # intermediate position from the first screenshot.
                            stable = observed == previous_observed
                            follows = not cursor_readings or all(
                                abs((observed[i] - cursor_readings[-1][0][i]) -
                                    (pointer[i] - cursor_readings[-1][1][i])) <= 8 for i in (0, 1))
                            if stable and follows:
                                cursor_readings.append((observed, pointer))
                                result['cursorReadings'] = cursor_readings
                                break
                            previous_observed = observed
                        time.sleep(1)
                    else:
                        raise AssertionError(f'Native cursor readout did not follow mouse movement: {observed}')
                    checks.append(f'native-cursor-readout:{observed[0]},{observed[1]}')
                if 'expectCounter' in action:
                    expected = action['expectCounter']
                    if expected == 'reset' and not counter_changed:
                        raise AssertionError('Cannot verify reset before a visible counter increment')
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        frame = capture('counter-' + expected)
                        difference = counter_difference(initial_counter, counter_region(frame))
                        if (expected == 'incremented' and difference > 2) or (expected == 'reset' and difference < 0.5):
                            counter_changed = counter_changed or expected == 'incremented'
                            break
                        time.sleep(0.5)
                    else:
                        raise AssertionError(f'Counter did not visibly {expected}: difference from initial={difference:.2f}')
                    checks.append('visible-counter:' + expected)
                if 'absentText' in action:
                    await_text(action['absentText'], limit=15, present=False)
                    checks.append('occluded-text:' + action['absentText'])
                time.sleep(action.get('settle', 1))
                after = capture(f'{index + 2:02d}-interaction')
                if action.get('expectChange'):
                    difference = ImageStat.Stat(ImageChops.difference(before.convert('RGB'), after.convert('RGB')))
                    if active_diagnostics:
                        result.setdefault('visibleChangeMeans', []).append(list(difference.mean))
                    if max(difference.mean) < 0.1:
                        raise AssertionError('Input did not produce a visible change')
                    checks.append('visible-response-to-input')
                before = after
            if process.poll() is not None:
                raise RuntimeError('App exited during interaction')
            result['ok'] = True
            if plan.get('nativeOnlyDiagnostics') and sys.platform == 'win32':
                native_only_after_outcome(plan, output, result, process, gui, shots)
    except Exception as error:
        result['error'] = str(error)
        try:
            gui.screenshot().save(output / 'failure.png')
            shots.append('failure.png')
        except Exception as capture_error:
            result['captureError'] = str(capture_error)
        if plan.get('nativeOnlyDiagnostics') and sys.platform == 'win32':
            native_only_after_outcome(plan, output, result, process, gui, shots)
        if window_diagnostics is not None:
            try:
                window_diagnostics.after_failure(gui, shots)
            except Exception as diagnostic_failure:
                diagnostic_error(result, 'post-failure', diagnostic_failure)
        raise
    finally:
        (output / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        if process:
            stop(process)


if __name__ == '__main__':
    inspect_app(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
