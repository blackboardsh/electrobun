package electrobun

import (
	"os"
	"runtime"
	"strings"
)

const InstallRootNameEnvironmentVariable = "ELECTROBUN_INSTALL_ROOT_NAME"

func isSafeInstallRootName(value string) bool {
	if value == "" || len(value) > 256 || value == "." || value == ".." {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < 0x20 || value[index] == 0x7f || value[index] == '/' || value[index] == '\\' {
			return false
		}
	}
	if runtime.GOOS == "windows" &&
		(strings.HasSuffix(value, " ") || strings.HasSuffix(value, ".") || strings.ContainsAny(value, "\"%*:<>?|")) {
		return false
	}
	return true
}

func effectiveInstallRootName(fallback string) string {
	if candidate, found := os.LookupEnv(InstallRootNameEnvironmentVariable); found && isSafeInstallRootName(candidate) {
		return candidate
	}
	return fallback
}
