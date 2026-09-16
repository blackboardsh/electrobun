//go:build cgo

package electrobun

import (
	"bytes"
	"math"
	"testing"
)

func TestAppInfoPackagedModeUsesCanonicalReleaseChannels(t *testing.T) {
	for _, channel := range []string{"stable", "canary"} {
		if !(AppInfo{Channel: channel}).IsPackaged() {
			t.Fatalf("expected %q to be packaged", channel)
		}
	}
	for _, channel := range []string{"", "dev", "production", "nightly"} {
		if (AppInfo{Channel: channel}).IsPackaged() {
			t.Fatalf("expected %q not to be packaged", channel)
		}
	}
}

func TestScreenCaptureRegionArgs(t *testing.T) {
	x, y, width, height, byteLength, err := screenCaptureRegionArgs(Rect{
		X:      12.9,
		Y:      -3.1,
		Width:  2,
		Height: 3,
	})
	if err != nil {
		t.Fatalf("unexpected validation error: %v", err)
	}
	if x != 12 || y != -4 {
		t.Fatalf("expected floored origin (12, -4), got (%v, %v)", x, y)
	}
	if width != 2 || height != 3 || byteLength != 24 {
		t.Fatalf("unexpected capture dimensions: %dx%d, %d bytes", width, height, byteLength)
	}
}

func TestCaptureScreenRegionReturnsExactRGBABytes(t *testing.T) {
	want := []byte{
		255, 0, 0, 255, 0, 255, 0, 128,
		0, 0, 255, 64, 255, 255, 255, 0,
	}
	called := false
	pixels, err := captureScreenRegionWith(
		Rect{X: 8.75, Y: -2.25, Width: 2, Height: 2},
		func(x, y float64, width, height uint32, out []byte) bool {
			called = true
			if x != 8 || y != -3 || width != 2 || height != 2 {
				t.Fatalf("unexpected native arguments: (%v, %v), %dx%d", x, y, width, height)
			}
			if len(out) != len(want) {
				t.Fatalf("expected %d output bytes, got %d", len(want), len(out))
			}
			copy(out, want)
			return true
		},
	)
	if err != nil {
		t.Fatalf("unexpected capture error: %v", err)
	}
	if !called {
		t.Fatal("expected capture function to be called")
	}
	if !bytes.Equal(pixels, want) {
		t.Fatalf("unexpected RGBA bytes: got %v, want %v", pixels, want)
	}
}

func TestCaptureScreenRegionReportsNativeFailure(t *testing.T) {
	pixels, err := captureScreenRegionWith(
		Rect{Width: 1, Height: 1},
		func(float64, float64, uint32, uint32, []byte) bool { return false },
	)
	if err == nil {
		t.Fatal("expected capture failure")
	}
	if pixels != nil {
		t.Fatalf("expected nil pixels on failure, got %v", pixels)
	}
}

func TestScreenCaptureRegionArgsRejectsInvalidRectangles(t *testing.T) {
	maxUint32 := float64(^uint32(0))
	tests := []struct {
		name string
		rect Rect
	}{
		{name: "NaN x", rect: Rect{X: math.NaN(), Width: 1, Height: 1}},
		{name: "infinite y", rect: Rect{Y: math.Inf(1), Width: 1, Height: 1}},
		{name: "zero width", rect: Rect{Width: 0, Height: 1}},
		{name: "negative height", rect: Rect{Width: 1, Height: -1}},
		{name: "fractional width", rect: Rect{Width: 1.5, Height: 1}},
		{name: "NaN height", rect: Rect{Width: 1, Height: math.NaN()}},
		{name: "oversized width", rect: Rect{Width: maxUint32 + 1, Height: 1}},
		{name: "RGBA length overflow", rect: Rect{Width: maxUint32, Height: maxUint32}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, _, _, _, err := screenCaptureRegionArgs(test.rect); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}
