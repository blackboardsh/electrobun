"""Bounded observation of real input, independent of desktop timing."""
import math
import unittest

from desktop import observe_bunny_rotation


class BunnyResponseTests(unittest.TestCase):
    def run_observation(self, frames, *, timeout=3, capture_cost=0, analysis_cost=0,
                        initial_time=0, started=None, running=lambda: None):
        now = [initial_time]
        pending = iter(frames)
        last = [0]
        evidence = {}

        def capture(sample):
            now[0] += capture_cost
            last[0] = next(pending, last[0])
            sample['screenshot'] = f'frame-{len(evidence["samples"])}.png'
            return last[0]

        def compare(before, after):
            now[0] += analysis_cost
            if isinstance(after, Exception):
                raise after
            return abs(after - before)

        def sleep(delay):
            now[0] += delay

        def run():
            return observe_bunny_rotation(0, None, capture, compare=compare,
                clock=lambda: now[0], sleep=sleep, started=started,
                response_timeout=timeout, observation=evidence,
                require_running=running)

        return run, evidence, now

    def test_late_response_is_observed_without_repeating_input(self):
        run, evidence, _ = self.run_observation([0] * 6 + [0.2, 0.3, 0.4, 0.4, 0.4])
        self.assertEqual(run(), 0.4)
        self.assertEqual(evidence['outcome'], 'passed')
        self.assertGreater(evidence['elapsedSeconds'], 1)
        self.assertEqual(evidence['samples'][-1]['settledSamples'], 3)
        self.assertEqual(evidence['samples'][-1]['difference'], 0.4)

    def test_unchanged_bunny_fails_at_the_deadline(self):
        run, evidence, now = self.run_observation([0])
        with self.assertRaisesRegex(AssertionError, 'did not visibly rotate'):
            run()
        self.assertEqual(now[0], 3)
        self.assertEqual(evidence['outcome'], 'failed')

    def test_transient_change_is_not_a_settled_response(self):
        run, evidence, _ = self.run_observation([0.3, 0.3, 0])
        with self.assertRaises(AssertionError):
            run()
        self.assertEqual(evidence['samples'][1]['settledSamples'], 2)
        self.assertEqual(evidence['samples'][2]['settledSamples'], 0)

    def test_missing_body_cannot_pass_or_join_two_separate_runs_of_samples(self):
        run, evidence, _ = self.run_observation(
            [0.3, 0.3, AssertionError('Bunny is occluded'), 0.3, 0.3, 0.3])
        self.assertEqual(run(), 0.3)
        self.assertEqual(evidence['matchedSample'], 5)
        self.assertEqual(evidence['samples'][2]['recognitionError'], 'Bunny is occluded')
        run, _, _ = self.run_observation([AssertionError('Bunny disappeared')])
        with self.assertRaises(AssertionError):
            run()

    def test_nonfinite_metric_never_counts_as_rotation(self):
        for value in (math.nan, math.inf):
            run, evidence, _ = self.run_observation([value])
            with self.assertRaises(AssertionError):
                run()
            self.assertIn('not finite', evidence['samples'][0]['recognitionError'])

    def test_capture_or_analysis_cannot_succeed_outside_the_budget(self):
        for costs in ({'capture_cost': 1}, {'analysis_cost': 0.5}):
            run, evidence, _ = self.run_observation([0.3], timeout=2, **costs)
            with self.assertRaises(AssertionError):
                run()
            self.assertEqual(evidence['outcome'], 'failed')

    def test_input_time_is_part_of_the_existing_response_budget(self):
        run, evidence, _ = self.run_observation([0.3], initial_time=2.75, started=0)
        with self.assertRaises(AssertionError):
            run()
        self.assertEqual(evidence['elapsedSeconds'], 3)
        self.assertEqual(len(evidence['samples']), 1)

    def test_process_failure_is_preserved(self):
        def exited():
            raise RuntimeError('app exited')
        run, evidence, _ = self.run_observation([0.3], running=exited)
        with self.assertRaisesRegex(RuntimeError, 'app exited'):
            run()
        self.assertEqual(evidence['samples'], [])
        self.assertEqual(evidence['error'], 'app exited')


if __name__ == '__main__':
    unittest.main()
