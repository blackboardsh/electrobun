package electrobun

import "testing"

func TestInstallRootNameValidation(t *testing.T) {
	for _, value := range []string{"stable", "Legacy App"} {
		if !isSafeInstallRootName(value) {
			t.Fatalf("expected %q to be safe", value)
		}
	}
	for _, value := range []string{"", ".", "..", "nested/root", "nested\\root", "line\nbreak"} {
		if isSafeInstallRootName(value) {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}
