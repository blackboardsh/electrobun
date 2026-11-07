package electrobun

import "core:encoding/json"
import "core:strings"
import "core:testing"

insights_test_config: [8192]u8
insights_test_config_len: int
insights_test_calls: int
insights_test_frees: int
insights_test_identify_cleared: bool
insights_test_track_calls: int

insights_configure_test_stub :: proc "c" (config: cstring) -> bool {
	text := string(config)
	insights_test_config_len = min(len(text), len(insights_test_config))
	copy(insights_test_config[:], transmute([]u8)text)
	insights_test_calls += 1
	return true
}

insights_id_test_stub :: proc "c" () -> cstring {
	return "installation-test"
}

insights_free_test_stub :: proc "c" (value: cstring) {
	if value != nil {
		insights_test_frees += 1
	}
}

insights_identify_test_stub :: proc "c" (value: cstring) {
	insights_test_identify_cleared = value == nil
}

insights_track_test_stub :: proc "c" (_: cstring, _: cstring) -> bool {
	insights_test_track_calls += 1
	return true
}

@(test)
insights_metadata_and_native_string_ownership :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	core.symbols.insightsConfigure = insights_configure_test_stub
	core.symbols.insightsGetInstallationId = insights_id_test_stub
	core.symbols.insightsIdentify = insights_identify_test_stub
	core.symbols.insightsTrack = insights_track_test_stub
	core.symbols.freeCoreString = insights_free_test_stub
	insights_test_calls = 0
	insights_test_frees = 0

	build_json := `{"insights":{"appId":"app-one","apiUrl":"https://insights.example/v1/electrobun"},"updateAuthority":"external","distribution":"app-store"}`
	version_json := `{"channel":"canary","version":"1.2.3","hash":"build-one"}`
	testing.expect(t, insightsConfigureFromJson(&core, build_json, version_json, "/profile/insights"))
	testing.expect_value(t, insights_test_calls, 1)
	config_json := string(insights_test_config[:insights_test_config_len])
	value, parse_err := json.parse_string(config_json)
	testing.expect_value(t, parse_err, json.Error.None)
	defer json.destroy_value(value)
	obj, object_ok := value.(json.Object)
	testing.expect(t, object_ok)
	app_id := string(obj["appId"].(json.String))
	version := string(obj["version"].(json.String))
	hash := string(obj["buildHash"].(json.String))
	storage_path := string(obj["storagePath"].(json.String))
	authority := string(obj["updateAuthority"].(json.String))
	distribution := string(obj["distribution"].(json.String))
	platform := string(obj["platform"].(json.String))
	testing.expect_value(t, app_id, "app-one")
	testing.expect_value(t, version, "1.2.3")
	testing.expect_value(t, hash, "build-one")
	testing.expect_value(t, storage_path, "/profile/insights")
	testing.expect_value(t, authority, "external")
	testing.expect_value(t, distribution, "app-store")
	when ODIN_OS == .Windows {
		testing.expect_value(t, platform, "win")
	} else when ODIN_OS == .Darwin {
		testing.expect_value(t, platform, "macos")
	} else {
		testing.expect_value(t, platform, "linux")
	}
	enabled, _ := obj["enabled"].(json.Boolean)
	testing.expect(t, !bool(enabled))

	// Disabled dev configuration still permits opt-in via insightsSetEnabled.
	testing.expect(t, insightsConfigureFromJson(&core, build_json, `{"channel":"dev"}`, "/profile/insights"))
	testing.expect_value(t, insights_test_calls, 2)
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"enabled":false`))
	testing.expect(t, insightsConfigureFromJson(&core, build_json, `{}`, "/profile/insights"))
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"channel":"dev"`))
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"enabled":false`))
	testing.expect(t, insightsConfigureFromJson(&core, `{"insights":{"appId":"app-one","apiUrl":"https://insights.example","enabled":true}}`, `{"channel":"dev"}`, "/profile/insights"))
	testing.expect_value(t, insights_test_calls, 4)
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"enabled":true`))
	testing.expect(t, insightsConfigureFromJson(&core, `{"insights":{"appId":"app-one","apiUrl":"https://insights.example","enabled":false}}`, `{"channel":"stable"}`, "/profile/insights"))
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"enabled":false`))
	// Release metadata takes precedence over build defaults for distributions.
	testing.expect(t, insightsConfigureFromJson(&core, build_json, `{"channel":"stable","distribution":"linux-deb","updateAuthority":"none"}`, "/profile/insights"))
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"distribution":"linux-deb"`))
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"updateAuthority":"none"`))
	testing.expect_value(t, insights_test_calls, 6)
	// Malformed configuration never reaches native code.
	testing.expect(t, !insightsConfigureFromJson(&core, "{", version_json, "/profile/insights"))
	testing.expect(t, !insightsConfigureFromJson(&core, `{"insights":{"appId":"app-one","apiUrl":"https://insights.example","enabled":"yes"}}`, version_json, "/profile/insights"))
	testing.expect_value(t, insights_test_calls, 6)

	installation_id := insightsGetInstallationId(&core)
	defer delete(installation_id, core.allocator)
	testing.expect_value(t, installation_id, "installation-test")
	testing.expect_value(t, insights_test_frees, 1)
	insightsIdentify(&core, "")
	testing.expect(t, insights_test_identify_cleared)
	insightsIdentify(&core, "user\x00truncated")
	testing.expect(t, insights_test_identify_cleared)
	insights_test_track_calls = 0
	testing.expect(t, !insightsTrack(&core, "name\x00truncated"))
	testing.expect(t, !insightsTrack(&core, "name", "{}\x00truncated"))
	testing.expect_value(t, insights_test_track_calls, 0)
	testing.expect(t, insightsTrack(&core, "name"))
	testing.expect_value(t, insights_test_track_calls, 1)
	insights_managed_service_defaults_and_explicit_overrides(t)
	insights_collection_requires_explicit_enable(t)
	insights_bundled_managed_custom_origin(t)
}

insights_bundled_managed_custom_origin :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	core.symbols.insightsConfigure = insights_configure_test_stub
	build_json := `{"insights":{"appId":"app-one","apiUrl":"https://updates.example.test"},"managed":{"appId":"app-one","baseUrl":"https://updates.example.test"}}`
	version_json := `{"channel":"stable","version":"1.5.0","hash":"custom-build","managed":{"appId":"app-one","baseUrl":"https://updates.example.test"}}`
	testing.expect(t, insightsConfigureFromJson(&core, build_json, version_json, "/profile/insights"))
	value, parse_err := json.parse_string(string(insights_test_config[:insights_test_config_len]))
	testing.expect_value(t, parse_err, json.Error.None)
	defer json.destroy_value(value)
	obj, object_ok := value.(json.Object)
	testing.expect(t, object_ok)
	testing.expect_value(t, string(obj["apiUrl"].(json.String)), "https://updates.example.test")
	testing.expect_value(t, string(obj["appId"].(json.String)), "app-one")
	testing.expect_value(t, string(obj["version"].(json.String)), "1.5.0")
	testing.expect_value(t, string(obj["buildHash"].(json.String)), "custom-build")
	testing.expect_value(t, string(obj["channel"].(json.String)), "stable")
	testing.expect(t, !bool(obj["enabled"].(json.Boolean)))
}

insights_collection_requires_explicit_enable :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	core.symbols.insightsConfigure = insights_configure_test_stub
	versions := []string{
		`{"channel":"stable"}`,
		`{"channel":"canary"}`,
		`{"channel":"dev"}`,
	}
	disabled_builds := []string{
		`{"insights":{"appId":"app-one"}}`,
		`{"insights":{"appId":"app-one","enabled":false}}`,
	}
	for version_json in versions {
		for build_json in disabled_builds {
			testing.expect(t, insightsConfigureFromJson(&core, build_json, version_json, "/profile/insights"))
			testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"enabled":false`))
		}
		testing.expect(t, insightsConfigureFromJson(&core, `{"insights":{"appId":"app-one","enabled":true}}`, version_json, "/profile/insights"))
		testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"enabled":true`))
	}
	testing.expect(t, insightsConfigure(&core, InsightsConfig{appId = "app-one", storagePath = "/profile/insights"}))
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"enabled":false`))
}

@(test)
insights_missing_optional_symbols_are_safe :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	testing.expect(t, !insightsConfigure(&core, {}))
	testing.expect(t, !insightsTrack(&core, "example"))
	testing.expect_value(t, insightsGetInstallationId(&core), "")
	insightsIdentify(&core, "opaque-user")
	insightsReset(&core)
	insightsSetEnabled(&core, false)
	insightsFlush(&core)
	insightsShutdown(&core)
}

insights_managed_service_defaults_and_explicit_overrides :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	core.symbols.insightsConfigure = insights_configure_test_stub
	insights_test_calls = 0
	testing.expect(t, insightsConfigureFromJson(&core, `{"insights":{"appId":"app-one"}}`, `{"channel":"stable"}`, "/profile/insights"))
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"apiUrl":"https://api.electrobun.dev"`))
	testing.expect(t, insightsConfigure(&core, InsightsConfig{appId = "app-one", storagePath = "/profile/insights"}))
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"apiUrl":"https://api.electrobun.dev"`))
	testing.expect(t, insightsConfigureFromJson(&core, `{"insights":{"appId":"app-one","apiUrl":"http://127.0.0.1:8787"}}`, `{"channel":"canary"}`, "/profile/insights"))
	testing.expect(t, strings.contains(string(insights_test_config[:insights_test_config_len]), `"apiUrl":"http://127.0.0.1:8787"`))
	testing.expect_value(t, insights_test_calls, 3)
	invalid_builds := []string{
		`{"insights":{"appId":"app-one","apiUrl":null}}`,
		`{"insights":{"appId":"app-one","apiUrl":false}}`,
		`{"insights":{"appId":"app-one","apiUrl":123}}`,
		`{"insights":{"appId":"app-one","apiUrl":""}}`,
	}
	for build_json in invalid_builds {
		testing.expect(t, !insightsConfigureFromJson(&core, build_json, `{"channel":"stable"}`, "/profile/insights"))
	}
	testing.expect_value(t, insights_test_calls, 3)
}
