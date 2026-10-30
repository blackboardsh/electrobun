package main

import (
	"fmt"
	"math"
	"time"
)

type fullscreenRect struct{ X, Y, Width, Height float64 }

type fullscreenSnapshot struct {
	Fullscreen bool
	Frame      fullscreenRect
	WorkArea   fullscreenRect
}

func fullscreenFrameRestored(actual, expected fullscreenRect) bool {
	return math.Abs(actual.X-expected.X) <= 1 && math.Abs(actual.Y-expected.Y) <= 1 &&
		math.Abs(actual.Width-expected.Width) <= 1 && math.Abs(actual.Height-expected.Height) <= 1
}

// A cleared fullscreen style bit can precede restoration of the desktop.
// Observe the single exit request; never submit another action from this wait.
func waitForFullscreenRestoration(before fullscreenSnapshot, timeout time.Duration, read func() (fullscreenSnapshot, error)) error {
	started := time.Now()
	deadline := started.Add(timeout)
	var first, last fullscreenSnapshot
	reads := 0
	for {
		sample, err := read()
		elapsed := time.Since(started)
		if err != nil {
			return fmt.Errorf("reading fullscreen restoration after %s: %w; expected=%+v observations=%d first=%+v last=%+v", elapsed, err, before, reads, first, last)
		}
		if reads == 0 {
			first = sample
		}
		last = sample
		reads++
		if elapsed <= timeout && !sample.Fullscreen && fullscreenFrameRestored(sample.Frame, before.Frame) && sample.WorkArea == before.WorkArea {
			return nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("fullscreen exit did not restore frame/workArea after %s (frame tolerance 1); expected=%+v first=%+v last=%+v", elapsed, before, first, last)
		}
		time.Sleep(min(25*time.Millisecond, remaining))
	}
}
