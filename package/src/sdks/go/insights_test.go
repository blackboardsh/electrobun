//go:build cgo

package electrobun

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func insightsTestBundle(t *testing.T, build, version string) BundlePaths {
	t.Helper()
	dir := t.TempDir()
	for name, value := range map[string]string{"build.json": build, "version.json": version} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return BundlePaths{ResourcesDir: dir}
}

func TestInsightsConfigurationUsesPackagedIdentity(t *testing.T) {
	bundle := insightsTestBundle(t,
		`{"insights":{"appId":"app_123","apiUrl":"https://cloud.example"},"updateAuthority":"direct","distribution":"direct"}`,
		`{"identifier":"dev.example.app","name":"Example","channel":"stable","version":"1.2.3","hash":"abc123","distribution":"app-store","updateAuthority":"external"}`)
	config, ok := InsightsConfigFromBuildConfig(bundle)
	if !ok {
		t.Fatal("expected valid Insights configuration")
	}
	if config.AppID != "app_123" || config.Version != "1.2.3" || config.BuildHash != "abc123" ||
		config.Channel != "stable" || config.UpdateAuthority != "external" || config.Distribution != "app-store" {
		t.Fatalf("unexpected metadata: %+v", config)
	}
	if config.Enabled == nil || *config.Enabled {
		t.Fatal("stable builds must leave configured Insights disabled by default")
	}
	paths, err := ResolvePaths(AppInfo{Identifier: "dev.example.app", Name: "Example", Channel: "stable"})
	if err != nil {
		t.Fatal(err)
	}
	if config.StoragePath != filepath.Join(paths.UserData, "insights") {
		t.Fatalf("Insights state must follow the installed app/profile: %s", config.StoragePath)
	}
	if config.Platform == "darwin" || config.Platform == "windows" || config.Arch == "amd64" {
		t.Fatal("expected Electrobun platform and architecture names")
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["buildHash"] != "abc123" || wire["appId"] != "app_123" || wire["enabled"] != false {
		t.Fatalf("unexpected native config: %s", encoded)
	}
}

func TestInsightsDistributionFallsBackToBuildMetadata(t *testing.T) {
	bundle := insightsTestBundle(t,
		`{"insights":{"appId":"a","apiUrl":"https://cloud.example"},"updateAuthority":"none","distribution":"package-manager"}`,
		`{"identifier":"dev.example.app","channel":"stable"}`)
	config, ok := InsightsConfigFromBuildConfig(bundle)
	if !ok || config.UpdateAuthority != "none" || config.Distribution != "package-manager" {
		t.Fatalf("expected build distribution fallback: %+v, ok=%v", config, ok)
	}
}

func TestInsightsPreservesBundledManagedCustomOrigin(t *testing.T) {
	// Hutch resolves the managed domain before packaging. The SDK must retain
	// that origin and app scope without treating domain setup as collection consent.
	bundle := insightsTestBundle(t,
		`{"insights":{"appId":"app_123","apiUrl":"https://updates.example.test"},"managed":{"appId":"app_123","baseUrl":"https://updates.example.test"}}`,
		`{"identifier":"dev.example.app","channel":"stable","version":"1.5.0","hash":"custom-build","managed":{"appId":"app_123","baseUrl":"https://updates.example.test"}}`)
	config, ok := InsightsConfigFromBuildConfig(bundle)
	if !ok || config.APIURL != "https://updates.example.test" || config.AppID != "app_123" ||
		config.Version != "1.5.0" || config.BuildHash != "custom-build" || config.Channel != "stable" ||
		config.Enabled == nil || *config.Enabled {
		t.Fatalf("expected the bundled custom origin, build identity, and disabled collection: %+v, ok=%v", config, ok)
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["apiUrl"] != "https://updates.example.test" || wire["appId"] != "app_123" || wire["enabled"] != false {
		t.Fatalf("unexpected native ingestion configuration: %s", encoded)
	}
}

func TestInsightsUsesHostedServiceWithoutEndpointConfiguration(t *testing.T) {
	bundle := insightsTestBundle(t,
		`{"insights":{"appId":"app_123"}}`,
		`{"identifier":"dev.example.app","channel":"stable","version":"1.0.0","hash":"build-1"}`)
	config, ok := InsightsConfigFromBuildConfig(bundle)
	if !ok || config.APIURL != "https://api.electrobun.dev" || config.AppID != "app_123" || config.Enabled == nil || *config.Enabled {
		t.Fatalf("expected hosted defaults: %+v, ok=%v", config, ok)
	}
	encoded, err := json.Marshal(InsightsConfig{AppID: "app_123", StoragePath: "/profile/insights"})
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if _, exists := wire["apiUrl"]; exists {
		t.Fatal("a zero-value APIURL must use the native default")
	}
	if _, exists := wire["enabled"]; exists {
		t.Fatal("a nil Enabled must use the native disabled default")
	}
}

func TestInsightsCollectionRequiresExplicitEnable(t *testing.T) {
	for _, test := range []struct {
		name    string
		channel string
		enabled string
		want    bool
	}{
		{"dev defaults disabled", "dev", "", false},
		{"dev explicitly enabled", "dev", `,"enabled":true`, true},
		{"dev explicitly disabled", "dev", `,"enabled":false`, false},
		{"canary defaults disabled", "canary", "", false},
		{"canary explicitly enabled", "canary", `,"enabled":true`, true},
		{"canary explicitly disabled", "canary", `,"enabled":false`, false},
		{"stable defaults disabled", "stable", "", false},
		{"stable explicitly enabled", "stable", `,"enabled":true`, true},
		{"stable explicitly disabled", "stable", `,"enabled":false`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			bundle := insightsTestBundle(t,
				`{"insights":{"appId":"a","apiUrl":"https://cloud.example"`+test.enabled+`}}`,
				`{"identifier":"dev.example.app","channel":"`+test.channel+`"}`)
			config, ok := InsightsConfigFromBuildConfig(bundle)
			if !ok || config.Enabled == nil || *config.Enabled != test.want {
				t.Fatalf("unexpected enabled result: %+v, ok=%v", config, ok)
			}
			if config.Version != "0.0.0" || config.Distribution != "direct" || config.UpdateAuthority != "direct" {
				t.Fatalf("unexpected metadata defaults: %+v", config)
			}
		})
	}
}

func TestInsightsSkipsMissingMalformedOrNestedConfiguration(t *testing.T) {
	validVersion := `{"identifier":"dev.example.app","channel":"stable"}`
	for _, test := range []struct {
		name    string
		build   string
		version string
	}{
		{"absent", `{}`, validVersion},
		{"null", `{"insights":null}`, validVersion},
		{"nested only", `{"other":{"insights":{"appId":"a","apiUrl":"https://cloud.example"}}}`, validVersion},
		{"malformed", `{"insights":`, validVersion},
		{"wrong enabled type", `{"insights":{"appId":"a","apiUrl":"https://cloud.example","enabled":"yes"}}`, validVersion},
		{"missing app", `{"insights":{"apiUrl":"https://cloud.example"}}`, validVersion},
		{"empty endpoint", `{"insights":{"appId":"a","apiUrl":""}}`, validVersion},
		{"null endpoint", `{"insights":{"appId":"a","apiUrl":null}}`, validVersion},
		{"wrong endpoint type", `{"insights":{"appId":"a","apiUrl":1}}`, validVersion},
		{"invalid version", `{"insights":{"appId":"a","apiUrl":"https://cloud.example"}}`, `invalid`},
		{"missing profile identity", `{"insights":{"appId":"a","apiUrl":"https://cloud.example"}}`, `{}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, ok := InsightsConfigFromBuildConfig(insightsTestBundle(t, test.build, test.version)); ok {
				t.Fatal("invalid Insights configuration must be ignored")
			}
		})
	}
	if _, ok := InsightsConfigFromBuildConfig(BundlePaths{ResourcesDir: t.TempDir()}); ok {
		t.Fatal("missing build metadata must be ignored")
	}
}

func TestInsightsOlderCoreRemainsUsable(t *testing.T) {
	core := &Core{}
	if ok, err := core.InsightsConfigure(InsightsConfig{}); ok || err != nil {
		t.Fatalf("unavailable configure should return false without error: %v, %v", ok, err)
	}
	if ok, err := core.InsightsTrack("example", nil); ok || err != nil {
		t.Fatalf("unavailable track should return false without error: %v, %v", ok, err)
	}
	if err := core.InsightsIdentify("opaque-user"); err != nil {
		t.Fatal(err)
	}
	if core.InsightsInstallationID() != "" {
		t.Fatal("unavailable core should have no installation ID")
	}
	core.InsightsReset()
	core.InsightsSetEnabled(false)
	core.InsightsFlush()
	core.InsightsShutdown()
}
