"""Time production OCR on a saved timely frame; this is not a live GUI test."""
import argparse
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import time

from PIL import Image

import desktop


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
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
