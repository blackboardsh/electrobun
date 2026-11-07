//go:build cgo

package electrobun

import (
	"encoding/json"
	"testing"
)

func TestInstallationIdentityWorksWithoutInsights(t *testing.T) {
	bundle := insightsTestBundle(t, `{}`, `{"identifier":"dev.example.app","channel":"stable","managed":{"appId":"app_123"}}`)
	config, ok := InstallationConfigFromBuildConfig(bundle)
	if !ok || config.AppID != "app_123" {
		t.Fatalf("hosting-only app needs shared identity: %+v, %v", config, ok)
	}
	if _, ok := InsightsConfigFromBuildConfig(bundle); ok {
		t.Fatal("hosting-only metadata must not configure an Insights reporter")
	}
}

func TestInstallationIdentityWorksWithoutCloudServices(t *testing.T) {
	bundle := insightsTestBundle(t, `{}`, `{"identifier":"dev.example.offline","channel":"stable"}`)
	config, ok := InstallationConfigFromBuildConfig(bundle)
	if !ok || config.AppID != "" || config.StoragePath == "" {
		t.Fatalf("offline app still needs a local installation identity: %+v, %v", config, ok)
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire) != 1 || wire["storagePath"] != config.StoragePath {
		t.Fatalf("offline configuration must omit the cloud migration hint: %s", encoded)
	}
	if _, ok := InsightsConfigFromBuildConfig(bundle); ok {
		t.Fatal("local identity must not configure Insights")
	}
}

func TestInstallationIdentityMatchesDisabledInsights(t *testing.T) {
	bundle := insightsTestBundle(t, `{"insights":{"appId":"app_123","enabled":false}}`, `{"identifier":"dev.example.app","channel":"stable","managed":{"appId":"app_123"}}`)
	identity, ok := InstallationConfigFromBuildConfig(bundle)
	insights, insightsOK := InsightsConfigFromBuildConfig(bundle)
	if !ok || !insightsOK || identity.AppID != insights.AppID || identity.StoragePath != insights.StoragePath {
		t.Fatalf("identity scope must equal existing Insights scope: %+v, %+v", identity, insights)
	}
	if insights.Enabled == nil || *insights.Enabled {
		t.Fatal("resolving identity must not enable analytics")
	}
	encoded, err := json.Marshal(identity)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire) != 2 || wire["appId"] != "app_123" || wire["storagePath"] != identity.StoragePath {
		t.Fatalf("identity configuration must contain no telemetry settings: %s", encoded)
	}
}

func TestInstallationIdentityRejectsConflictingApps(t *testing.T) {
	for _, test := range []struct{ build, version string }{
		{`{"insights":{"appId":"one"}}`, `{"identifier":"example","managed":{"appId":"two"}}`},
		{`{"managed":{"appId":"one"}}`, `{"identifier":"example","managed":{"appId":"two"}}`},
		{`{}`, `{"identifier":"example","managed":{"appId":""}}`},
		{`{}`, `{"managed":{"appId":"one"}}`},
	} {
		if _, ok := InstallationConfigFromBuildConfig(insightsTestBundle(t, test.build, test.version)); ok {
			t.Fatalf("unexpected identity accepted: %s / %s", test.build, test.version)
		}
	}
}

func TestInstallationOlderCoreRemainsUsable(t *testing.T) {
	core := &Core{}
	if ok, err := core.InstallationConfigure(InstallationConfig{AppID: "app_123", StoragePath: "/profile/insights"}); ok || err != nil {
		t.Fatalf("older core must gracefully report unsupported identity: %v, %v", ok, err)
	}
	if core.InstallationID() != "" || core.InsightsInstallationID() != "" {
		t.Fatal("older core must not generate a replacement ID in the SDK")
	}
}
