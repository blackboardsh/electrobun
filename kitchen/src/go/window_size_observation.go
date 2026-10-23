package main

import (
	"fmt"
	"math"
	"time"
)

// Observe completion without submitting another resize: a request that never
// takes effect must still fail, even when the window manager is busy.
func waitForWindowSize(width, height, tolerance float64, timeout time.Duration, readSize func() (float64, float64, error)) error {
	started := time.Now()
	deadline := started.Add(timeout)
	for {
		observedWidth, observedHeight, err := readSize()
		if err != nil {
			return fmt.Errorf("reading window size while waiting for %gx%g after %s: %w", width, height, time.Since(started), err)
		}
		elapsed := time.Since(started)
		if elapsed <= timeout && math.Abs(observedWidth-width) <= tolerance && math.Abs(observedHeight-height) <= tolerance {
			return nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("timed out waiting for window size %gx%g (tolerance %g) after %s: last observed %gx%g", width, height, tolerance, elapsed, observedWidth, observedHeight)
		}
		time.Sleep(min(25*time.Millisecond, remaining))
	}
}
