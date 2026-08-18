//go:build cgo

package electrobun

import "testing"

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
