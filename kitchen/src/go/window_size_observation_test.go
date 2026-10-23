package main

import (
	"errors"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func TestWindowSizeWaitAcceptsDelayedCompletion(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		reads := 0
		err := waitForWindowSize(600, 500, 24, time.Second, func() (float64, float64, error) {
			reads++
			if time.Since(started) < 175*time.Millisecond {
				return 420, 308, nil
			}
			return 600, 500, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if elapsed := time.Since(started); elapsed < 175*time.Millisecond || elapsed >= time.Second || reads < 2 {
			t.Fatalf("did not observe delayed completion: elapsed=%s, reads=%d", elapsed, reads)
		}
	})
}

func TestWindowSizeWaitRequiresBothDimensions(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		err := waitForWindowSize(600, 500, 24, time.Second, func() (float64, float64, error) {
			if time.Since(started) < 200*time.Millisecond {
				return 600, 308, nil
			}
			return 624, 476, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if time.Since(started) < 200*time.Millisecond {
			t.Fatal("matching width completed the wait before height reached the unchanged tolerance")
		}
	})
}

func TestWindowSizeWaitFailsWhenResizeNeverCompletes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		err := waitForWindowSize(600, 500, 24, 60*time.Millisecond, func() (float64, float64, error) {
			return 420, 308, nil
		})
		if err == nil {
			t.Fatal("resize that never took effect passed")
		}
		if elapsed := time.Since(started); elapsed != 60*time.Millisecond {
			t.Fatalf("wait exceeded its deadline: %s", elapsed)
		}
		for _, detail := range []string{"600x500", "tolerance 24", "60ms", "last observed 420x308"} {
			if !strings.Contains(err.Error(), detail) {
				t.Fatalf("timeout lacks %q: %v", detail, err)
			}
		}
	})
}

func TestWindowSizeWaitPropagatesReadFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		readFailure := errors.New("window closed")
		reads := 0
		started := time.Now()
		err := waitForWindowSize(320, 240, 24, time.Second, func() (float64, float64, error) {
			reads++
			if reads == 1 {
				return 600, 500, nil
			}
			return 0, 0, readFailure
		})
		if !errors.Is(err, readFailure) {
			t.Fatalf("read failure was lost: %v", err)
		}
		if reads != 2 || time.Since(started) >= time.Second {
			t.Fatal("read failure was retried until the deadline")
		}
		if !strings.Contains(err.Error(), "320x240") {
			t.Fatalf("read failure lacks the requested size: %v", err)
		}
	})
}

func TestWindowSizeWaitRejectsCompletionObservedAfterDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		err := waitForWindowSize(600, 500, 24, time.Second, func() (float64, float64, error) {
			// A synchronous native frame read can block behind other UI work.
			time.Sleep(2 * time.Second)
			return 600, 500, nil
		})
		if err == nil {
			t.Fatal("matching dimensions observed after the deadline passed")
		}
		for _, detail := range []string{"600x500", "after 2s", "last observed 600x500"} {
			if !strings.Contains(err.Error(), detail) {
				t.Fatalf("late completion lacks %q: %v", detail, err)
			}
		}
	})
}

func TestWindowSizeWaitReturnsImmediatelyForCompletedResize(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		err := waitForWindowSize(320, 240, 24, time.Second, func() (float64, float64, error) {
			return 320, 240, nil
		})
		if err != nil || time.Since(started) != 0 {
			t.Fatalf("completed resize waited unnecessarily: %v", err)
		}
	})
}
