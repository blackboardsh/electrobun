//go:build cgo

package electrobun

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// InstallationConfig locates the native app/profile ID. AppID is an optional
// migration hint for existing Insights identities, not the identity scope.
// This configuration never starts Insights or sends a network request.
type InstallationConfig struct {
	AppID       string `json:"appId,omitempty"`
	StoragePath string `json:"storagePath"`
}

// InstallationConfigFromBuildConfig resolves the shared managed/Insights
// identity independently of the analytics enabled flag. Conflicting app IDs
// are rejected, since updates and analytics must identify the same app install.
func InstallationConfigFromBuildConfig(bundlePaths BundlePaths) (InstallationConfig, bool) {
	buildJSON, err := os.ReadFile(filepath.Join(bundlePaths.ResourcesDir, "build.json"))
	if err != nil {
		return InstallationConfig{}, false
	}
	type service struct {
		AppID string `json:"appId"`
	}
	var build struct {
		Insights *service `json:"insights"`
		Managed  *service `json:"managed"`
	}
	if json.Unmarshal(buildJSON, &build) != nil {
		return InstallationConfig{}, false
	}
	versionJSON, err := os.ReadFile(filepath.Join(bundlePaths.ResourcesDir, "version.json"))
	if err != nil {
		return InstallationConfig{}, false
	}
	var version struct {
		Identifier string   `json:"identifier"`
		Name       string   `json:"name"`
		Channel    string   `json:"channel"`
		Managed    *service `json:"managed"`
	}
	if json.Unmarshal(versionJSON, &version) != nil || version.Identifier == "" {
		return InstallationConfig{}, false
	}
	appID := ""
	for _, config := range []*service{version.Managed, build.Managed, build.Insights} {
		if config == nil {
			continue
		}
		if config.AppID == "" || (appID != "" && appID != config.AppID) {
			return InstallationConfig{}, false
		}
		appID = config.AppID
	}
	if version.Channel == "" {
		version.Channel = "dev"
	}
	paths, err := ResolvePaths(AppInfo{Identifier: version.Identifier, Name: version.Name, Channel: version.Channel})
	if err != nil {
		return InstallationConfig{}, false
	}
	// Retain the original persisted Insights identity location for compatibility.
	return InstallationConfig{AppID: appID, StoragePath: filepath.Join(paths.UserData, "insights")}, true
}
