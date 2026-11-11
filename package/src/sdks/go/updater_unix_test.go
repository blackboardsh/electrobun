//go:build cgo && !windows

package electrobun

import "testing"

// Unix permits unlinking a loaded fixture; Go's production Core has no unload API.
func releaseUpdaterFixture(_ *testing.T, _ *Core) {}
