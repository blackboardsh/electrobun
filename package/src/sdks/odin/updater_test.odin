package electrobun

import "core:dynlib"
import "core:encoding/json"
import "core:strings"
import "core:testing"

updater_test_input: [4096]u8
updater_test_input_len: int
updater_test_configure_calls: int
updater_test_request_calls: int
updater_test_free_calls: int
updater_test_shutdown_calls: int
updater_test_stop_calls: int
updater_test_after: u64
updater_test_limit: u32
updater_test_request_output: cstring
updater_test_state_output: cstring

updater_test_configure :: proc "c" (value: cstring) -> bool {
	text := string(value)
	updater_test_input_len = min(len(text), len(updater_test_input))
	copy(updater_test_input[:], transmute([]u8)text)
	updater_test_configure_calls += 1
	return true
}

updater_test_request :: proc "c" (value: cstring) -> cstring {
	text := string(value)
	updater_test_input_len = min(len(text), len(updater_test_input))
	copy(updater_test_input[:], transmute([]u8)text)
	updater_test_request_calls += 1
	return updater_test_request_output
}

updater_test_state :: proc "c" () -> cstring { return updater_test_state_output }

updater_test_events :: proc "c" (after: u64, limit: u32) -> cstring {
	updater_test_after = after
	updater_test_limit = limit
	return `{"schemaVersion":1,"entries":[{"sequence":9007199254740993,"status":"download-progress","message":"downloading","timestamp":123,"details":{"bytesDownloaded":1234,"totalBytes":2468,"progress":50,"usedPatchPath":false}}],"nextSequence":9007199254740993,"oldestSequence":9007199254740980,"overflow":true}`
}

updater_test_free :: proc "c" (value: cstring) {
	if value != nil { updater_test_free_calls += 1 }
}

updater_test_shutdown :: proc "c" () { updater_test_shutdown_calls += 1 }
updater_test_stop :: proc "c" () { updater_test_stop_calls += 1 }

@(test)
updater_polling_ownership_tokens_and_errors :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	core.symbols.updaterConfigure = updater_test_configure
	core.symbols.updaterRequest = updater_test_request
	core.symbols.updaterGetState = updater_test_state
	core.symbols.updaterGetEvents = updater_test_events
	core.symbols.updaterShutdown = updater_test_shutdown
	core.symbols.freeCoreString = updater_test_free
	core.symbols.stopEventLoop = updater_test_stop
	updater_test_configure_calls = 0
	updater_test_request_calls = 0
	updater_test_free_calls = 0
	updater_test_shutdown_calls = 0
	updater_test_stop_calls = 0
	updater_test_request_output = `{"schemaVersion":1,"accepted":true,"operationId":"op-one","error":null}`
	updater_test_state_output = `{"schemaVersion":1,"revision":2,"operationId":"op-one","operation":"requestApply","operationState":"awaitingApproval","localInfo":{"version":"1","hash":"old","baseUrl":"https://updates.test","channel":"stable","name":"Example","identifier":"dev.test","managed":{"appId":"app-one","apiUrl":"https://api.test"},"updateAuthority":"direct"},"updateInfo":{"version":"2","hash":"new","updateAvailable":true,"updateReady":true,"error":""},"approval":{"id":"approval-one","preparedHash":"new"},"quitReady":false,"channelRoot":"/profile/updates/stable","operations":[{"operationId":"older","operation":"check","state":"completed","error":null,"updateInfo":{"version":"2","hash":"new","updateAvailable":true,"updateReady":false,"error":""}}]}`

	// Local configuration sends paths and schema only, without any action.
	testing.expect_value(t, updaterConfigure(&core, {"/app/bin", "/app/Resources"}), Error.None)
	testing.expect_value(t, updater_test_configure_calls, 1)
	testing.expect_value(t, updater_test_request_calls, 0)
	config, config_err := json.parse_string(string(updater_test_input[:updater_test_input_len]))
	testing.expect_value(t, config_err, json.Error.None)
	defer json.destroy_value(config)
	config_object := config.(json.Object)
	testing.expect_value(t, len(config_object), 3)
	testing.expect_value(t, string(config_object["exeDir"].(json.String)), "/app/bin")
	testing.expect_value(t, string(config_object["resourcesDir"].(json.String)), "/app/Resources")
	testing.expect_value(t, updaterConfigure(&core, {"/app\x00bad", "/resources"}), Error.InvalidExePath)
	testing.expect_value(t, updater_test_configure_calls, 1)

	request, request_err := updaterRequestApply(&core)
	defer updaterRequestResultDeinit(&request)
	testing.expect_value(t, request_err, Error.None)
	testing.expect(t, request.accepted)
	testing.expect_value(t, request.operationId.?, "op-one")
	testing.expect_value(t, updater_test_free_calls, 1)
	testing.expect(t, strings.contains(string(updater_test_input[:updater_test_input_len]), `"action":"requestApply"`))

	state, state_err := updaterGetState(&core)
	defer updaterStateDeinit(&state)
	testing.expect_value(t, state_err, Error.None)
	testing.expect_value(t, state.operationState, UpdaterOperationState.awaitingApproval)
	testing.expect(t, !state.quitReady)
	testing.expect_value(t, state.approval.?.id, "approval-one")
	testing.expect_value(t, state.approval.?.preparedHash, "new")
	testing.expect_value(t, state.localInfo.managed.?.appId, "app-one")
	testing.expect_value(t, state.operations[0].state, UpdaterOperationState.completed)
	testing.expect(t, !state.operations[0].updateInfo.?.updateReady)
	testing.expect_value(t, updater_test_free_calls, 2)

	// Veto carries the exact operation and approval tokens, including false.
	veto, veto_err := updaterApproveApply(&core, request.operationId.?, state.approval.?.id, false)
	defer updaterRequestResultDeinit(&veto)
	testing.expect_value(t, veto_err, Error.None)
	veto_json, veto_json_err := json.parse_string(string(updater_test_input[:updater_test_input_len]))
	testing.expect_value(t, veto_json_err, json.Error.None)
	defer json.destroy_value(veto_json)
	veto_object := veto_json.(json.Object)
	testing.expect_value(t, string(veto_object["operationId"].(json.String)), "op-one")
	testing.expect_value(t, string(veto_object["approvalId"].(json.String)), "approval-one")
	testing.expect(t, !bool(veto_object["approved"].(json.Boolean)))
	testing.expect_value(t, updater_test_stop_calls, 0)

	approve, approve_err := updaterApproveApply(&core, "op-one", "approval-one", true)
	defer updaterRequestResultDeinit(&approve)
	testing.expect_value(t, approve_err, Error.None)
	testing.expect(t, strings.contains(string(updater_test_input[:updater_test_input_len]), `"approved":true`))
	testing.expect_value(t, updater_test_stop_calls, 0)

	// Terminal completion still requires an explicit quitReady handoff signal.
	updater_test_state_output = `{"schemaVersion":1,"revision":3,"operationId":"op-one","operation":"requestApply","operationState":"completed","localInfo":{"version":"1","hash":"old","baseUrl":"","channel":"stable","name":"Example","identifier":"dev.test"},"updateInfo":{"version":"2","hash":"new","updateAvailable":true,"updateReady":true,"error":""},"approval":null,"quitReady":true,"channelRoot":"/profile/updates/stable","operations":[]}`
	ready, ready_err := updaterGetState(&core)
	defer updaterStateDeinit(&ready)
	testing.expect_value(t, ready_err, Error.None)
	testing.expect(t, ready.quitReady)
	testing.expect(t, ready.approval == nil)
	testing.expect_value(t, updater_test_stop_calls, 0)

	info, info_err := updaterGetLocalInfo(&core)
	defer updaterLocalInfoDeinit(&info)
	testing.expect_value(t, info_err, Error.None)
	testing.expect_value(t, info.identifier, "dev.test")

	events, events_err := updaterGetEvents(&core, 9007199254740992, 7)
	defer updaterEventsDeinit(&events)
	testing.expect_value(t, events_err, Error.None)
	testing.expect_value(t, updater_test_after, 9007199254740992)
	testing.expect_value(t, updater_test_limit, 7)
	testing.expect_value(t, events.nextSequence, 9007199254740993)
	testing.expect(t, events.overflow)
	testing.expect(t, events.entries[0].operationId == nil) // Core omits absent event IDs.
	testing.expect_value(t, events.entries[0].details.?.progress.?, 50)
	testing.expect(t, !events.entries[0].details.?.usedPatchPath.?)

	actions := []string{"check", "download", "reconcile", "cancel"}
	for action in actions {
		result: UpdaterRequestResult
		err: Error
		switch action {
		case "check": result, err = updaterCheck(&core)
		case "download": result, err = updaterDownload(&core)
		case "reconcile": result, err = updaterReconcile(&core)
		case "cancel": result, err = updaterCancel(&core, "op-one")
		}
		testing.expect_value(t, err, Error.None)
		updaterRequestResultDeinit(&result)
		testing.expect(t, strings.contains(string(updater_test_input[:updater_test_input_len]), action))
	}

	frees_before_errors := updater_test_free_calls
	updater_test_request_output = `{"schemaVersion":1,"accepted":false,"operationId":"op-one","error":"stale approval"}`
	rejected, rejected_err := updaterApproveApply(&core, "op-one", "stale", true)
	defer updaterRequestResultDeinit(&rejected)
	testing.expect_value(t, rejected_err, Error.UpdaterRejected)
	testing.expect_value(t, rejected.error.?, "stale approval")
	updater_test_request_output = `{"schemaVersion":2,"accepted":true}`
	invalid, invalid_err := updaterCheck(&core)
	defer updaterRequestResultDeinit(&invalid)
	testing.expect_value(t, invalid_err, Error.UpdaterSchemaMismatch)
	updater_test_request_output = `{"schemaVersion":1,"accepted":` // Partial allocations are released.
	malformed, malformed_err := updaterCheck(&core)
	defer updaterRequestResultDeinit(&malformed)
	testing.expect_value(t, malformed_err, Error.InvalidJson)
	testing.expect_value(t, updater_test_free_calls, frees_before_errors + 3)
	updater_test_state_output = `{"schemaVersion":1,"revision":1,"operationId":"op-one","operation":"requestApply","operationState":"awaitingApproval","localInfo":{},"updateInfo":{},"quitReady":false,"operations":[],"approval":null}`
	bad_state, bad_state_err := updaterGetState(&core)
	defer updaterStateDeinit(&bad_state)
	testing.expect_value(t, bad_state_err, Error.InvalidJson)

	// The standard Odin decoder otherwise accepts enum numbers and narrows
	// oversized schema integers. Validate the wire representation first.
	bad_enum_states := []cstring{
		`{"schemaVersion":1,"revision":1,"operationId":null,"operationState":999,"operation":null,"localInfo":{},"updateInfo":{},"quitReady":true,"operations":[]}`,
		`{"schemaVersion":1,"revision":1,"operationId":null,"operationState":1,"operation":null,"localInfo":{},"updateInfo":{},"quitReady":true,"operations":[]}`,
		`{"schemaVersion":1,"revision":1,"operationId":null,"operationState":"idle","operation":1,"localInfo":{},"updateInfo":{},"quitReady":false,"operations":[]}`,
		`{"schemaVersion":1,"revision":1,"operationId":null,"operationState":"idle","operation":null,"localInfo":{},"updateInfo":{},"quitReady":false,"operations":[{"operationId":"one","operation":"check","state":999}]}`,
		`{"schemaVersion":1,"revision":1,"operationId":null,"operationState":"idle","operation":null,"localInfo":{},"updateInfo":{},"quitReady":false,"operations":[{"operationId":"one","operation":1,"state":"completed"}]}`,
	}
	for wire in bad_enum_states {
		updater_test_state_output = wire
		bad_enum, bad_enum_err := updaterGetState(&core)
		updaterStateDeinit(&bad_enum)
		testing.expect_value(t, bad_enum_err, Error.InvalidJson)
	}
	updater_test_state_output = `{"schemaVersion":4294967297,"operationState":"idle","quitReady":false}`
	large_schema, large_schema_err := updaterGetState(&core)
	updaterStateDeinit(&large_schema)
	testing.expect_value(t, large_schema_err, Error.UpdaterSchemaMismatch)

	testing.expect_value(t, updaterShutdown(&core), Error.None)
	testing.expect_value(t, updater_test_shutdown_calls, 1)
	testing.expect(t, !core.updater_configured)
	testing.expect_value(t, updater_test_stop_calls, 0)
	testing.expect_value(t, updater_test_configure_calls, 1)
}

@(test)
updater_old_core_reports_unavailable :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	testing.expect_value(t, updaterConfigure(&core, {"/app/bin", "/app/Resources"}), Error.UpdaterUnavailable)
	state, state_err := updaterGetState(&core)
	defer updaterStateDeinit(&state)
	testing.expect_value(t, state_err, Error.UpdaterUnavailable)
	request, request_err := updaterCheck(&core)
	defer updaterRequestResultDeinit(&request)
	testing.expect_value(t, request_err, Error.UpdaterUnavailable)
	testing.expect_value(t, updaterShutdown(&core), Error.UpdaterUnavailable)
}

updater_close_test_shutdown_calls: int
updater_close_test_handler_cleared_after_shutdown: bool

updater_close_test_shutdown :: proc "c" () {
	updater_close_test_shutdown_calls += 1
}

updater_close_test_set_quit_handler :: proc "c" (handler: QuitRequestedHandler) {
	updater_close_test_handler_cleared_after_shutdown = handler == nil && updater_close_test_shutdown_calls == 1
}

@(test)
updater_close_joins_before_releasing_runtime_and_ignores_unused_handles :: proc(t: ^testing.T) {
	// Use a real loader reference so coreClose follows its production unload
	// path. Stub only the updater and runtime callback registration boundary.
	library_name := "libc.so.6"
	when ODIN_OS == .Darwin { library_name = "/usr/lib/libSystem.B.dylib" }
	when ODIN_OS == .Windows { library_name = "kernel32.dll" }
	library, loaded := dynlib.load_library(library_name)
	testing.expect(t, loaded)
	if !loaded { return }
	updater_close_test_shutdown_calls = 0
	updater_close_test_handler_cleared_after_shutdown = false
	core := Core{allocator = context.allocator, updater_configured = true}
	core.symbols.__handle = library
	core.symbols.updaterShutdown = updater_close_test_shutdown
	core.symbols.setQuitRequestedHandler = updater_close_test_set_quit_handler
	coreClose(&core)
	testing.expect_value(t, updater_close_test_shutdown_calls, 1)
	testing.expect(t, updater_close_test_handler_cleared_after_shutdown)
	testing.expect(t, core.symbols.__handle == nil)
	testing.expect(t, !core.updater_configured)

	unused_library, unused_loaded := dynlib.load_library(library_name)
	testing.expect(t, unused_loaded)
	if !unused_loaded { return }
	unused := Core{allocator = context.allocator}
	unused.symbols.__handle = unused_library
	unused.symbols.updaterShutdown = updater_close_test_shutdown
	coreClose(&unused)
	testing.expect_value(t, updater_close_test_shutdown_calls, 1)
	testing.expect(t, unused.symbols.__handle == nil)
}
