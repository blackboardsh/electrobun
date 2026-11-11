//go:build cgo && windows

package electrobun

import (
	"syscall"
	"testing"
)

// Windows holds loaded DLLs open. Release the fixture before TempDir cleanup.
// No fixture functions execute after this cleanup; the fixture has no worker.
func releaseUpdaterFixture(t *testing.T, core *Core) {
	t.Helper()
	if err := syscall.FreeLibrary(syscall.Handle(uintptr(core.lib))); err != nil {
		t.Errorf("release updater fixture DLL: %v", err)
	}
}
