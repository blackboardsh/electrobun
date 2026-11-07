package electrobun

import "core:encoding/json"
import "core:strings"
import "core:testing"

installation_test_json: [8192]u8
installation_test_json_len: int
installation_test_configure_calls: int
installation_test_insights_calls: int
installation_test_free_calls: int

installation_configure_test_stub :: proc "c" (config: cstring) -> bool {
	text := string(config)
	installation_test_json_len = min(len(text), len(installation_test_json))
	copy(installation_test_json[:], transmute([]u8)text)
	installation_test_configure_calls += 1
	return true
}

installation_insights_test_stub :: proc "c" (_: cstring) -> bool {
	installation_test_insights_calls += 1
	return true
}

installation_get_test_stub :: proc "c" () -> cstring {
	return "1234567890abcdef1234567890abcdef"
}

installation_free_test_stub :: proc "c" (value: cstring) {
	if value != nil {
		installation_test_free_calls += 1
	}
}

@(test)
installation_identity_is_independent_from_collection :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	core.symbols.installationConfigure = installation_configure_test_stub
	core.symbols.getInstallationId = installation_get_test_stub
	core.symbols.freeCoreString = installation_free_test_stub
	core.symbols.insightsConfigure = installation_insights_test_stub
	installation_test_configure_calls = 0
	installation_test_insights_calls = 0
	installation_test_free_calls = 0

	// Hosting-only metadata configures identity without calling the Insights ABI.
	testing.expect(t, installationConfigureFromJson(&core, `{}`, `{"managed":{"appId":"app-one"}}`, "/profile/insights"))
	testing.expect_value(t, installation_test_configure_calls, 1)
	testing.expect_value(t, installation_test_insights_calls, 0)
	value, err := json.parse_string(string(installation_test_json[:installation_test_json_len]))
	testing.expect_value(t, err, json.Error.None)
	defer json.destroy_value(value)
	obj, ok := value.(json.Object)
	testing.expect(t, ok)
	testing.expect_value(t, string(obj["appId"].(json.String)), "app-one")
	testing.expect_value(t, string(obj["storagePath"].(json.String)), "/profile/insights")
	testing.expect_value(t, len(obj), 2)

	// An Insights app gets the same scope even with collection explicitly off.
	testing.expect(t, installationConfigureFromJson(&core, `{"insights":{"appId":"app-one","enabled":false}}`, `{}`, "/profile/insights"))
	testing.expect(t, installationConfigureFromJson(&core, `{"insights":{"appId":"app-one"}}`, `{"managed":{"appId":"app-one"}}`, "/profile/insights"))
	testing.expect_value(t, installation_test_configure_calls, 3)
	testing.expect_value(t, installation_test_insights_calls, 0)
	id := getInstallationId(&core)
	defer delete(id, core.allocator)
	testing.expect_value(t, id, "1234567890abcdef1234567890abcdef")
	testing.expect_value(t, installation_test_free_calls, 1)
	// The old getter retains its reporter-only behavior.
	testing.expect_value(t, insightsGetInstallationId(&core), "")

	invalid_builds := []string{
		`{"insights":{"appId":"different-app"}}`,
		`{"insights":{"appId":""}}`,
		`{"insights":{"appId":false}}`,
		`{"managed":{"appId":"different-app"}}`,
		`{`,
	}
	for build_json in invalid_builds {
		testing.expect(t, !installationConfigureFromJson(&core, build_json, `{"managed":{"appId":"app-one"}}`, "/profile/insights"))
	}
	// Every app can display its ID, even without managed hosting or Insights.
	testing.expect(t, installationConfigureFromJson(&core, `{}`, `{}`, "/profile/insights"))
	testing.expect(t, strings.contains(string(installation_test_json[:installation_test_json_len]), `"storagePath":"/profile/insights"`))
	testing.expect(t, !strings.contains(string(installation_test_json[:installation_test_json_len]), `"appId"`))
	// Null optional service settings are absent, matching the other SDKs.
	testing.expect(t, installationConfigureFromJson(&core, `{"insights":null,"managed":null}`, `{"managed":null}`, "/profile/insights"))
	testing.expect(t, !strings.contains(string(installation_test_json[:installation_test_json_len]), `"appId"`))
	// Only known top-level fields supply a migration hint. Version Insights and
	// nested example objects must not override the actual managed app ID.
	testing.expect(t, installationConfigureFromJson(&core, `{"example":{"insights":{"appId":"nested"}}}`, `{"insights":{"appId":"ignored"},"managed":{"appId":"app-one"}}`, "/profile/insights"))
	testing.expect(t, strings.contains(string(installation_test_json[:installation_test_json_len]), `"appId":"app-one"`))
	testing.expect(t, !installationConfigureFromJson(&core, `{}`, `{"managed":{"appId":"app-one"}}`, ""))
	testing.expect(t, !installationConfigure(&core, {appId = "app\x00one", storagePath = "/profile/insights"}))
	testing.expect_value(t, installation_test_configure_calls, 6)
	testing.expect_value(t, installation_test_insights_calls, 0)
	testing.expect(t, !strings.contains(string(installation_test_json[:installation_test_json_len]), `"enabled"`))
}

@(test)
installation_missing_optional_symbols_are_safe :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	testing.expect(t, !installationConfigure(&core, {appId = "app-one", storagePath = "/profile/insights"}))
	testing.expect_value(t, getInstallationId(&core), "")
}
