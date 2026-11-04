"""Time production OCR on a saved timely frame; this is not a live GUI test."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

from PIL import Image

import desktop


def compare_batch(source, output, contention_workers=0):
    """Compare exact OCR outputs under the original final/early frame budgets."""
    result_path = source / 'kitchen-native-ui' / 'result.json'
    original = json.loads(result_path.read_text(encoding='utf-8'))
    absence = next(value for value in reversed(original['textObservations'])
                   if value['condition'] == 'absent')
    assert absence['responseTimeoutSeconds'] == 15
    assert absence['analysisTimeoutSeconds'] == 120

    def eligible(sample, observation):
        finished = sample['captureFinishedSeconds']
        return (sample.get('eligible') is True and math.isfinite(finished)
                and 0 <= finished <= observation['responseTimeoutSeconds'])

    negative_samples = [sample for sample in absence['samples'] if eligible(sample, absence)]
    assert negative_samples, 'Source artifact has no timely eligible absence frame'
    capture_cost = max(15, *(sample['captureFinishedSeconds'] for sample in absence['samples']))
    assert math.isfinite(capture_cost) and capture_cost < 120
    presence = next(value for value in reversed(original['textObservations'])
                    if value['condition'] == 'present' and value.get('outcome') == 'passed'
                    and value['expected'] == absence['expected'])
    positive_sample = presence['samples'][presence['matchedSample']]
    assert eligible(positive_sample, presence), 'Matched presence frame was captured too late'
    command = os.environ['SMOKE_TESSERACT']
    version = subprocess.run([command, '--version'], capture_output=True, text=True, check=True)
    report = {
        'kind': 'saved-frame-ocr-batch-comparison-not-live-gui',
        'sourceRun': os.environ.get('SOURCE_RUN'),
        'sourceArtifact': os.environ.get('SOURCE_ARTIFACT'),
        'replayCommit': os.environ.get('GITHUB_SHA'),
        'python': platform.python_version(), 'pythonMachine': platform.machine(),
        'pythonArchitecture': platform.architecture()[0],
        'tesseractVersion': (version.stdout + version.stderr).strip(),
        'sourceResult': str(result_path), 'cases': {}, 'ok': False,
        'syntheticCPUContentionWorkers': contention_workers,
        'syntheticCPUContentionIsNativeApp': False,
        'syntheticCPUContentionMaxSeconds': 330,
        'syntheticCPUContentionWarmupSeconds': 2 if contention_workers else 0,
    }

    def source_case(name, observation, selected, budget):
        image_path = (result_path.parent / selected['windowScreenshot']).resolve()
        assert image_path.is_relative_to(source), 'Source image escaped the artifact'
        with Image.open(image_path) as opened:
            image = opened.copy()
        shutil.copyfile(image_path, output / f'source-frame-{name}.png')
        case = {
            'sourceImage': str(image_path),
            'sourceImageSha256': hashlib.sha256(image_path.read_bytes()).hexdigest(),
            'sourceSampleIndex': observation['samples'].index(selected),
            'sourceCaptureStartedSeconds': selected['captureStartedSeconds'],
            'sourceCaptureFinishedSeconds': selected['captureFinishedSeconds'],
            'sourceObservationStartedAtEpochSeconds': observation['startedAtEpochSeconds'],
            'sourceResponseBudgetSeconds': observation['responseTimeoutSeconds'],
            'sourceOverallBudgetSeconds': observation['analysisTimeoutSeconds'],
            'sourceExpected': observation['expected'], 'sourceCondition': observation['condition'],
            'ocrBudgetSeconds': budget, 'imageSize': list(image.size), 'runs': {}, 'ok': False,
        }
        if name == 'absence':
            case['chargedCaptureSeconds'] = capture_cost
        else:
            case['earlyFrameBudgetSeconds'] = 20
            case['sourceMatchedSample'] = observation['matchedSample']
        report['cases'][name] = case
        return image, case

    def run_ocr(image, case, name, batch):
        run = {'mode': 'batch' if batch else 'separate', 'ocrBudgetSeconds': case['ocrBudgetSeconds'],
               'regions': [], 'processes': [], 'calls': [], 'generatedRegions': [], 'ok': False}
        region_metadata = {}
        active_call = None
        original_run = desktop.subprocess.run

        def regions(frame):
            for region, top, config, scale, left in desktop.ocr_regions(frame):
                metadata = {
                    'index': len(run['generatedRegions']), 'size': list(region.size),
                    'mode': region.mode, 'top': top, 'left': left, 'scale': scale, 'config': config,
                    'pixelSha256': hashlib.sha256(region.tobytes()).hexdigest(),
                }
                run['generatedRegions'].append(metadata)
                region_metadata[id(region)] = metadata
                yield region, top, config, scale, left

        def timed_run(*positional, **kwargs):
            started = time.monotonic()
            process = {'index': len(run['processes']), 'timeoutSeconds': kwargs.get('timeout'),
                       'callIndex': active_call['index'], 'regionIndexes': active_call['regionIndexes']}
            run['processes'].append(process)
            try:
                value = original_run(*positional, **kwargs)
                process['returncode'] = value.returncode
                return value
            except Exception as error:
                process['error'] = str(error)
                raise
            finally:
                process['elapsedSeconds'] = time.monotonic() - started

        def recognize_images(images, config, timeout, batched):
            nonlocal active_call
            started = time.monotonic()
            details = [dict(region_metadata[id(region)]) for region in images]
            call = {'index': len(run['calls']), 'batch': batched, 'config': config,
                    'submittedTimeoutSeconds': timeout,
                    'regionIndexes': [detail['index'] for detail in details]}
            run['calls'].append(call)
            for detail in details:
                assert detail['config'] == config
                detail['callIndex'] = call['index']
                run['regions'].append(detail)
            active_call = call
            try:
                if batched:
                    texts = desktop.recognize_text_batch(images, config=config,
                                                        timeout=timeout, command=command)
                else:
                    texts = [desktop.recognize_text(images[0], config=config,
                                                   timeout=timeout, command=command)]
                assert len(texts) == len(details), 'OCR lost or added a page, including blank pages'
                for detail, text in zip(details, texts):
                    detail.update(text=text, textCharacters=len(text))
                return texts
            except Exception as error:
                call['error'] = str(error)
                raise
            finally:
                call['elapsedSeconds'] = time.monotonic() - started
                active_call = None
                print(json.dumps({'case': name, 'mode': run['mode'], 'call': call}), flush=True)

        def recognize(region, *, config, timeout):
            return recognize_images([region], config, timeout, False)[0]

        def recognize_batch(images, *, config, timeout):
            return recognize_images(images, config, timeout, True)

        evidence = {}
        started = time.monotonic()
        desktop.subprocess.run = timed_run
        try:
            options = {'recognize_batch': recognize_batch} if batch else {}
            found = desktop.image_has_text(image, case['sourceExpected'], recognize,
                deadline=started + case['ocrBudgetSeconds'], observation=evidence, regions=regions,
                **options)
            run['found'] = found
            if name == 'absence':
                assert found is False and evidence.get('ocrComplete') is True, \
                    'Only a complete negative OCR scan may pass this absence replay'
                assert len(run['regions']) == 15, 'Absence replay must inspect all 15 original regions'
                assert evidence['ocrPasses'] == 15
            else:
                assert found is True, 'Portal text was not detected within the 20-second early-frame budget'
            run['ok'] = True
        except Exception as error:
            run['error'] = str(error)
        finally:
            desktop.subprocess.run = original_run
            run['elapsedOcrSeconds'] = time.monotonic() - started
            if name == 'absence':
                run['chargedOverallSeconds'] = capture_cost + run['elapsedOcrSeconds']
            run['evidence'] = evidence
            (output / f'{name}-{run["mode"]}.json').write_text(json.dumps(run, indent=2), encoding='utf-8')
        return run

    def compare_outputs(case, require_all):
        separate, batch = case['runs']['separate'], case['runs']['batch']
        fields = ('index', 'size', 'mode', 'top', 'left', 'scale', 'config', 'pixelSha256', 'text')
        def exact_regions(run):
            return [{field: region.get(field) for field in fields} for region in run['regions']]
        left, right = exact_regions(separate), exact_regions(batch)
        comparison = {'separateRegionCount': len(left), 'batchRegionCount': len(right),
                      'exactRegionOutputsEqual': left == right,
                      'separateBlankPages': sum(region.get('text') == '' for region in separate['regions']),
                      'batchBlankPages': sum(region.get('text') == '' for region in batch['regions'])}
        if require_all:
            comparison['all15RegionsRetained'] = len(left) == len(right) == 15
        comparison['ok'] = separate['ok'] and batch['ok'] and left == right
        if require_all:
            comparison['ok'] = comparison['ok'] and comparison['all15RegionsRetained']
        case['comparison'] = comparison
        case['ok'] = comparison['ok']

    workers = []
    try:
        prepared = []
        for name, observation, selected, budget in (
                ('absence', absence, negative_samples[-1], 120 - capture_cost),
                ('presence', presence, positive_sample, 20)):
            image, case = source_case(name, observation, selected, budget)
            prepared.append((name, image, case))

        # This is synthetic CPU contention, not a substitute for rendering the
        # native app. Each independent child self-terminates even if this
        # diagnostic is interrupted before its normal finally cleanup.
        worker_code = '''import time
deadline = time.monotonic() + 330
value = 1
while time.monotonic() < deadline:
    for _ in range(10000):
        value = (value * 1664525 + 1013904223) & 0xffffffff
'''
        for _ in range(contention_workers):
            workers.append(subprocess.Popen([sys.executable, '-c', worker_code],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        report['syntheticCPUContentionPids'] = [worker.pid for worker in workers]
        if workers:
            time.sleep(report['syntheticCPUContentionWarmupSeconds'])
            assert all(worker.poll() is None for worker in workers), 'A CPU contention worker exited during warmup'
        for name, image, case in prepared:
            for batch in (False, True):
                assert all(worker.poll() is None for worker in workers), 'A CPU contention worker exited early'
                mode = 'batch' if batch else 'separate'
                case['runs'][mode] = run_ocr(image, case, name, batch)
                assert all(worker.poll() is None for worker in workers), 'A CPU contention worker exited early'
            compare_outputs(case, name == 'absence')
        report['ok'] = all(case['ok'] for case in report['cases'].values())
    except Exception as error:
        report['error'] = str(error)
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.terminate()
        for worker in workers:
            try:
                worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait(timeout=5)
        report['syntheticCPUContentionCleanupComplete'] = all(worker.poll() is not None for worker in workers)
        (output / 'comparison.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps({'kind': report['kind'], 'ok': report['ok'],
                          'cases': {name: case.get('comparison') for name, case in report['cases'].items()}}), flush=True)
    assert report['ok'], report.get('error', 'Saved-frame OCR batch comparison failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--compare-batch', action='store_true')
    parser.add_argument('--contention-workers', type=int, default=0)
    args = parser.parse_args()
    if not 0 <= args.contention_workers <= 16:
        parser.error('--contention-workers must be between 0 and 16')
    if args.contention_workers and not args.compare_batch:
        parser.error('--contention-workers requires --compare-batch')
    source, output = args.source.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.compare_batch:
        compare_batch(source, output, args.contention_workers)
        return
    result_path = source / 'kitchen-native-ui' / 'result.json'
    original = json.loads(result_path.read_text(encoding='utf-8'))
    observation = next(value for value in reversed(original['textObservations'])
                       if value['condition'] == 'absent')
    response_budget = observation['responseTimeoutSeconds']
    analysis_budget = observation['analysisTimeoutSeconds']
    assert response_budget == 15 and analysis_budget == 120, 'Unexpected source deadlines'
    eligible = [sample for sample in observation['samples']
                if sample.get('eligible') is True
                and math.isfinite(sample['captureFinishedSeconds'])
                and 0 <= sample['captureFinishedSeconds'] <= response_budget]
    assert eligible, 'Source artifact has no timely eligible absence frame'
    selected = eligible[-1]
    # Charge even a late capture's overrun, but retain only the preceding
    # timely frame. This gives ARM103.438s, not a fresh120s analysis budget.
    capture_cost = max(response_budget, *(sample['captureFinishedSeconds']
                       for sample in observation['samples']))
    assert math.isfinite(capture_cost) and capture_cost < analysis_budget
    remaining_budget = analysis_budget - capture_cost
    image_path = (result_path.parent / selected['windowScreenshot']).resolve()
    assert image_path.is_relative_to(source), 'Source image escaped the artifact'
    with Image.open(image_path) as opened:
        image = opened.copy()
    shutil.copyfile(image_path, output / 'source-frame.png')
    command = os.environ['SMOKE_TESSERACT']
    version = subprocess.run([command, '--version'], capture_output=True, text=True, check=True)
    report = {
        'kind': 'saved-frame-ocr-replay-not-live-gui',
        'sourceRun': os.environ.get('SOURCE_RUN'),
        'sourceArtifact': os.environ.get('SOURCE_ARTIFACT'),
        'replayCommit': os.environ.get('GITHUB_SHA'),
        'python': platform.python_version(),
        'pythonMachine': platform.machine(),
        'pythonArchitecture': platform.architecture()[0],
        'tesseractVersion': (version.stdout + version.stderr).strip(),
        'sourceResult': str(result_path), 'sourceImage': str(image_path),
        'sourceCaptureStartedSeconds': selected['captureStartedSeconds'],
        'sourceCaptureFinishedSeconds': selected['captureFinishedSeconds'],
        'sourceObservationStartedAtEpochSeconds': observation['startedAtEpochSeconds'],
        'sourceResponseBudgetSeconds': response_budget,
        'sourceOverallBudgetSeconds': analysis_budget,
        'chargedCaptureSeconds': capture_cost,
        'remainingOcrBudgetSeconds': remaining_budget,
        'imageSize': list(image.size), 'regions': [], 'processes': [], 'ok': False,
    }
    original_run = desktop.subprocess.run

    def timed_run(*positional, **kwargs):
        started = time.monotonic()
        process = {'index': len(report['processes']), 'timeoutSeconds': kwargs.get('timeout')}
        report['processes'].append(process)
        try:
            value = original_run(*positional, **kwargs)
            process['returncode'] = value.returncode
            return value
        except Exception as error:
            process['error'] = str(error)
            raise
        finally:
            process['elapsedSeconds'] = time.monotonic() - started

    def recognize(region, *, config, timeout):
        started = time.monotonic()
        detail = {'index': len(report['regions']), 'size': list(region.size),
                  'config': config, 'submittedTimeoutSeconds': timeout}
        report['regions'].append(detail)
        try:
            value = desktop.recognize_text(region, config=config, timeout=timeout, command=command)
            detail['textCharacters'] = len(value)
            detail['text'] = value
            return value
        except Exception as error:
            detail['error'] = str(error)
            raise
        finally:
            detail['elapsedSeconds'] = time.monotonic() - started
            print(json.dumps({'region': {key: value for key, value in detail.items()
                                          if key != 'text'}}), flush=True)

    evidence = {}
    started = time.monotonic()
    desktop.subprocess.run = timed_run
    try:
        found = desktop.image_has_text(image, observation['expected'], recognize,
                                       deadline=started + remaining_budget,
                                       observation=evidence)
        assert found is False and evidence.get('ocrComplete') is True, \
            'Only a complete negative OCR scan may pass this absence replay'
        report['ok'] = True
    except Exception as error:
        report['error'] = str(error)
    finally:
        desktop.subprocess.run = original_run
        report['elapsedOcrSeconds'] = time.monotonic() - started
        report['chargedOverallSeconds'] = capture_cost + report['elapsedOcrSeconds']
        report['evidence'] = evidence
        (output / 'replay.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps({key: report[key] for key in (
            'kind', 'ok', 'sourceImage', 'sourceCaptureFinishedSeconds',
            'remainingOcrBudgetSeconds', 'elapsedOcrSeconds', 'chargedOverallSeconds')}), flush=True)
    assert report['ok'], report.get('error', 'Saved-frame OCR replay failed')


if __name__ == '__main__':
    main()
