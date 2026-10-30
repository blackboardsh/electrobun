package main

import (
	"errors"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

var fullscreenBefore = fullscreenSnapshot{
	Frame: fullscreenRect{140, 100, 640, 420}, WorkArea: fullscreenRect{0, 25, 1920, 1015},
}

func TestFullscreenRestorationWaitsForFrameAndWorkArea(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		err := waitForFullscreenRestoration(fullscreenBefore, time.Second, func() (fullscreenSnapshot, error) {
			sample := fullscreenBefore
			elapsed := time.Since(started)
			if elapsed < 50*time.Millisecond {
				sample.Fullscreen = true
			} else if elapsed < 100*time.Millisecond {
				sample.Frame.Height = 1080
			} else if elapsed < 175*time.Millisecond {
				sample.WorkArea.Height++
			}
			return sample, nil
		})
		if err != nil || time.Since(started) != 175*time.Millisecond {
			t.Fatalf("restoration was not fully observed: elapsed=%s error=%v", time.Since(started), err)
		}
	})
}

func TestFullscreenRestorationPreservesTolerances(t *testing.T) {
	for _, field := range []string{"x", "y", "width", "height"} {
		t.Run(field, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				sample := fullscreenBefore
				fields := map[string]*float64{"x": &sample.Frame.X, "y": &sample.Frame.Y, "width": &sample.Frame.Width, "height": &sample.Frame.Height}
				*fields[field] += 1
				if err := waitForFullscreenRestoration(fullscreenBefore, time.Millisecond, func() (fullscreenSnapshot, error) { return sample, nil }); err != nil {
					t.Fatal(err)
				}
				*fields[field] += 0.01
				if err := waitForFullscreenRestoration(fullscreenBefore, time.Millisecond, func() (fullscreenSnapshot, error) { return sample, nil }); err == nil {
					t.Fatal("frame beyond one-pixel tolerance passed")
				}
			})
		})
	}
}

func TestFullscreenRestorationFailsWithoutRestoration(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		reads := 0
		err := waitForFullscreenRestoration(fullscreenBefore, 60*time.Millisecond, func() (fullscreenSnapshot, error) {
			reads++
			sample := fullscreenBefore
			sample.WorkArea.Y += float64(reads)
			return sample, nil
		})
		if err == nil || time.Since(started) != 60*time.Millisecond {
			t.Fatalf("non-restoration escaped deadline: %v", err)
		}
		for _, detail := range []string{"60ms", "expected=", "first=", "last=", "Y:26", "Y:29"} {
			if !strings.Contains(err.Error(), detail) {
				t.Fatalf("missing %q: %v", detail, err)
			}
		}
	})
}

func TestFullscreenRestorationRejectsReadFailureAndLateSuccess(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		readErr := errors.New("display unavailable")
		reads := 0
		err := waitForFullscreenRestoration(fullscreenBefore, time.Second, func() (fullscreenSnapshot, error) {
			reads++
			return fullscreenBefore, readErr
		})
		if !errors.Is(err, readErr) || reads != 1 {
			t.Fatalf("read error was retried or lost: %v", err)
		}
		err = waitForFullscreenRestoration(fullscreenBefore, time.Second, func() (fullscreenSnapshot, error) {
			time.Sleep(2 * time.Second)
			return fullscreenBefore, nil
		})
		if err == nil || !strings.Contains(err.Error(), "after 2s") {
			t.Fatalf("late success passed: %v", err)
		}
	})
}
