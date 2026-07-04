use crate::electrobun::{
    self, AppInfo, BundlePaths, Core, Rect, WebviewCallbacks, WebviewOptions, WindowOptions,
};
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const APP_VERSION: &str = "1.18.1";
const DEFAULT_SECRET_KEY: &str = "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32";
const TEST_HARNESS_URL: &str = "views://zig/index.html";

static APP_STATE: OnceLock<AppState> = OnceLock::new();
static HOST_QUEUE_RUNNING: AtomicBool = AtomicBool::new(false);

struct AppState {
    core: &'static Core,
    bundle_paths: BundlePaths,
    default_renderer: String,
    cef_available: bool,
    cef_version: Option<String>,
    rust_version: Option<String>,
    search_query: Mutex<String>,
    test_runner_webview_id: Mutex<Option<u32>>,
    auto_run_all: bool,
    auto_run_test_name: Option<String>,
    auto_run_triggered: AtomicBool,
}

#[derive(Clone, Copy)]
enum TestKind {
    Smoke,
    WindowCreateClose,
    WebviewCreate,
}

#[derive(Clone, Copy)]
struct RustTest {
    id: &'static str,
    name: &'static str,
    category: &'static str,
    description: &'static str,
    interactive: bool,
    kind: TestKind,
}

struct TestRunResult {
    status: &'static str,
    duration_ms: u128,
    error: Option<String>,
}

const RUST_TESTS: &[RustTest] = &[
    RustTest {
        id: "rust-smoke-test",
        name: "Rust host smoke test",
        category: "Rust Native",
        description: "Verify the Rust main process and view RPC bridge are running.",
        interactive: false,
        kind: TestKind::Smoke,
    },
    RustTest {
        id: "rust-window-create-close",
        name: "Window create/close (Rust)",
        category: "BrowserWindow",
        description: "Create a native window through the Rust SDK and close it again.",
        interactive: false,
        kind: TestKind::WindowCreateClose,
    },
    RustTest {
        id: "rust-webview-create",
        name: "BrowserView create (Rust)",
        category: "BrowserView",
        description: "Create a secondary native webview through the Rust SDK.",
        interactive: false,
        kind: TestKind::WebviewCreate,
    },
];

pub fn main() {
    if let Err(err) = run() {
        eprintln!("[kitchen rust] {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let core = Box::leak(Box::new(Core::load()?));
    let bundle_paths = electrobun::resolve_bundle_paths()?;
    let app_info = electrobun::resolve_app_info_from_bundle(&bundle_paths)?;
    let runtime_config = read_runtime_build_config(&bundle_paths);

    APP_STATE
        .set(AppState {
            core,
            bundle_paths,
            default_renderer: runtime_config.default_renderer,
            cef_available: runtime_config.cef_available,
            cef_version: runtime_config.cef_version,
            rust_version: runtime_config.rust_version,
            search_query: Mutex::new(String::new()),
            test_runner_webview_id: Mutex::new(None),
            auto_run_all: std::env::var("AUTO_RUN").is_ok(),
            auto_run_test_name: std::env::var("AUTO_RUN_TEST_NAME").ok(),
            auto_run_triggered: AtomicBool::new(false),
        })
        .map_err(|_| "failed to initialize Rust kitchen state".to_string())?;

    let _ui_thread = thread::spawn(create_ui);

    HOST_QUEUE_RUNNING.store(true, Ordering::Release);
    let host_queue_thread = thread::spawn(drain_host_message_queue);
    let run_result = core.run_main_thread(&app_info);
    HOST_QUEUE_RUNNING.store(false, Ordering::Release);
    let _ = host_queue_thread.join();
    run_result
}

struct RuntimeBuildConfig {
    default_renderer: String,
    cef_available: bool,
    cef_version: Option<String>,
    rust_version: Option<String>,
}

fn read_runtime_build_config(bundle_paths: &BundlePaths) -> RuntimeBuildConfig {
    let path = bundle_paths.resources_dir.join("build.json");
    let build_json = std::fs::read_to_string(path).unwrap_or_default();
    let default_renderer = electrobun::json_string_field(&build_json, "defaultRenderer")
        .unwrap_or_else(|| "native".to_string());
    let cef_available = build_json.contains("\"cef\"");

    RuntimeBuildConfig {
        default_renderer,
        cef_available,
        cef_version: electrobun::json_string_field(&build_json, "cefVersion"),
        rust_version: electrobun::json_string_field(&build_json, "rustVersion"),
    }
}

fn app_state() -> &'static AppState {
    APP_STATE
        .get()
        .expect("electrobun kitchen rust state not initialized")
}

fn create_ui() {
    thread::sleep(Duration::from_millis(150));
    let state = app_state();

    if let Err(err) = state
        .core
        .configure_webview_runtime_from_executable_dir(&state.bundle_paths, 0)
    {
        eprintln!("[kitchen rust] failed to configure webview runtime: {err}");
        return;
    }

    let window_id = match state.core.create_window(WindowOptions::new(
        "Electrobun Integration Tests",
        Rect::new(100.0, 100.0, 1200.0, 800.0),
    )) {
        Ok(id) => id,
        Err(err) => {
            eprintln!("[kitchen rust] failed to create test runner window: {err}");
            return;
        }
    };

    let mut webview_options = WebviewOptions::new(
        window_id,
        "views://test-runner/index.html",
        Rect::new(0.0, 0.0, 1200.0, 800.0),
    );
    webview_options.secret_key = DEFAULT_SECRET_KEY;
    webview_options.sandbox = false;
    webview_options.callbacks = WebviewCallbacks {
        decide_navigation: Some(electrobun::allow_all_navigation),
        event: Some(test_runner_webview_event),
        event_bridge: Some(electrobun::noop_webview_post_message),
        host_bridge: Some(test_runner_host_bridge),
        internal_bridge: Some(electrobun::noop_webview_post_message),
        ..WebviewCallbacks::default()
    };

    let webview_id = match state.core.create_webview(webview_options) {
        Ok(id) => id,
        Err(err) => {
            eprintln!("[kitchen rust] failed to create test runner webview: {err}");
            let _ = state.core.close_window(window_id);
            return;
        }
    };

    if let Ok(mut guard) = state.test_runner_webview_id.lock() {
        *guard = Some(webview_id);
    }
}

fn drain_host_message_queue() {
    while HOST_QUEUE_RUNNING.load(Ordering::Acquire) {
        let state = app_state();
        let mut drained_any = false;
        while HOST_QUEUE_RUNNING.load(Ordering::Acquire) {
            let Some((webview_id, message)) = state.core.pop_next_queued_host_message_string()
            else {
                break;
            };
            handle_host_bridge_packet(webview_id, &message);
            drained_any = true;
        }

        if !drained_any {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

extern "C" fn test_runner_webview_event(
    webview_id: u32,
    event_name: *const c_char,
    _detail: *const c_char,
) {
    let event_name = electrobun::c_string_to_string(event_name);
    if event_name != "dom-ready" {
        return;
    }

    let state = app_state();
    let is_test_runner = state
        .test_runner_webview_id
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .map(|id| id == webview_id)
        .unwrap_or(false);
    if !is_test_runner {
        return;
    }

    send_build_config(webview_id);
    send_update_status(webview_id);
}

extern "C" fn test_runner_host_bridge(webview_id: u32, message: *const c_char) {
    let message = electrobun::c_string_to_string(message);
    handle_host_bridge_packet(webview_id, &message);
}

fn handle_host_bridge_packet(webview_id: u32, message: &str) {
    let Some(packet_type) = electrobun::json_string_field(message, "type") else {
        return;
    };

    if packet_type == "request" {
        let Some(request_id) = json_u64_field(message, "id") else {
            return;
        };
        let Some(method) = electrobun::json_string_field(message, "method") else {
            return;
        };
        handle_rpc_request(webview_id, request_id, &method, message);
        return;
    }

    if packet_type == "message" {
        if let Some(message_id) = electrobun::json_string_field(message, "id") {
            handle_rpc_message(&message_id, message);
        }
    }
}

fn handle_rpc_request(webview_id: u32, request_id: u64, method: &str, packet: &str) {
    eprintln!("[kitchen rust] RPC request: {method}");

    match method {
        "getTests" => {
            send_rpc_response_success(webview_id, request_id, &tests_json());
            send_initial_ui_state(webview_id);
            maybe_auto_run_after_handshake(webview_id);
        }
        "getTestRunnerPreferences" => {
            let query = app_state()
                .search_query
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default();
            let payload = format!(
                "{{\"searchQuery\":{}}}",
                electrobun::json_string_literal(&query)
            );
            send_rpc_response_success(webview_id, request_id, &payload);
            send_initial_ui_state(webview_id);
        }
        "setTestRunnerPreferences" => {
            if let Some(query) = electrobun::json_string_field(packet, "searchQuery") {
                if let Ok(mut guard) = app_state().search_query.lock() {
                    *guard = query;
                }
            }
            send_rpc_response_success(webview_id, request_id, "{}");
        }
        "runTest" => {
            let Some(test_id) = electrobun::json_string_field(packet, "testId") else {
                send_rpc_response_error(webview_id, request_id, "Missing testId");
                return;
            };
            let Some(test) = find_test_by_id(&test_id) else {
                send_rpc_response_error(webview_id, request_id, "Unknown test id");
                return;
            };
            start_single_test(webview_id, Some(request_id), test);
        }
        "runAllAutomated" => {
            start_all_tests(webview_id, Some(request_id), false);
        }
        "runInteractiveTests" => {
            start_all_tests(webview_id, Some(request_id), true);
        }
        "submitInteractiveResult"
        | "submitReady"
        | "submitVerification"
        | "applyUpdate"
        | "clearUpdateStatusHistory" => {
            send_rpc_response_success(webview_id, request_id, "{}");
        }
        "getUpdateStatusHistory" => {
            send_rpc_response_success(webview_id, request_id, "[]");
        }
        _ => {
            send_rpc_response_error(webview_id, request_id, "Unknown RPC request");
        }
    }
}

fn handle_rpc_message(message_id: &str, packet: &str) {
    if message_id == "logToBun" {
        if let Some(msg) = electrobun::json_string_field(packet, "msg") {
            eprintln!("[kitchen rust ui] {msg}");
        }
    }
}

fn find_test_by_id(test_id: &str) -> Option<RustTest> {
    RUST_TESTS.iter().copied().find(|test| test.id == test_id)
}

fn find_test_by_name_or_id(value: &str) -> Option<RustTest> {
    RUST_TESTS
        .iter()
        .copied()
        .find(|test| test.id == value || test.name == value)
}

fn run_selected_tests(webview_id: u32, interactive_only: bool) -> String {
    let mut results = Vec::new();
    for test in RUST_TESTS {
        if test.interactive != interactive_only {
            continue;
        }
        results.push(execute_single_test_and_broadcast(webview_id, *test));
    }
    let payload = format!("{{\"results\":[{}]}}", results.join(","));
    send_rpc_message(webview_id, "allCompleted", &payload);
    format!("[{}]", results.join(","))
}

fn start_single_test(webview_id: u32, request_id: Option<u64>, test: RustTest) {
    thread::spawn(move || {
        let result_json = execute_single_test_and_broadcast(webview_id, test);
        if let Some(request_id) = request_id {
            send_rpc_response_success(webview_id, request_id, &result_json);
        }
    });
}

fn start_all_tests(webview_id: u32, request_id: Option<u64>, interactive_only: bool) {
    thread::spawn(move || {
        let results = run_selected_tests(webview_id, interactive_only);
        if let Some(request_id) = request_id {
            send_rpc_response_success(webview_id, request_id, &results);
        }
    });
}

fn execute_single_test_and_broadcast(webview_id: u32, test: RustTest) -> String {
    eprintln!("[kitchen rust] running test: {}", test.name);
    send_rpc_message(
        webview_id,
        "testStarted",
        &format!(
            "{{\"testId\":{},\"name\":{}}}",
            electrobun::json_string_literal(test.id),
            electrobun::json_string_literal(test.name)
        ),
    );
    send_test_log(webview_id, test.id, "Running Rust native test");

    let result = run_rust_test(test);
    if let Some(error) = &result.error {
        send_test_log(webview_id, test.id, error);
    }

    let result_json = test_result_json(test, &result);
    send_rpc_message(
        webview_id,
        "testCompleted",
        &format!(
            "{{\"testId\":{},\"result\":{}}}",
            electrobun::json_string_literal(test.id),
            result_json
        ),
    );
    eprintln!("[kitchen rust] completed test: {} -> {}", test.name, result.status);
    result_json
}

fn run_rust_test(test: RustTest) -> TestRunResult {
    let started = Instant::now();
    let result = match test.kind {
        TestKind::Smoke => Ok(()),
        TestKind::WindowCreateClose => run_window_create_close_test(),
        TestKind::WebviewCreate => run_webview_create_test(),
    };

    TestRunResult {
        status: if result.is_ok() { "passed" } else { "failed" },
        duration_ms: started.elapsed().as_millis(),
        error: result.err(),
    }
}

fn run_window_create_close_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Window Create/Close Test",
        Rect::new(80.0, 80.0, 420.0, 280.0),
    );
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    thread::sleep(Duration::from_millis(50));
    state.core.close_window(window_id)
}

fn run_webview_create_test() -> Result<(), String> {
    let state = app_state();
    let mut window_options = WindowOptions::new(
        "Rust BrowserView Create Test",
        Rect::new(120.0, 120.0, 640.0, 420.0),
    );
    window_options.hidden = true;
    window_options.activate = false;
    let window_id = state.core.create_window(window_options)?;

    let mut webview_options = WebviewOptions::new(
        window_id,
        TEST_HARNESS_URL,
        Rect::new(0.0, 0.0, 640.0, 420.0),
    );
    webview_options.secret_key = DEFAULT_SECRET_KEY;
    webview_options.sandbox = true;
    webview_options.callbacks = WebviewCallbacks {
        decide_navigation: Some(electrobun::allow_all_navigation),
        event: Some(electrobun::noop_webview_event),
        event_bridge: Some(electrobun::noop_webview_post_message),
        host_bridge: Some(electrobun::noop_webview_post_message),
        internal_bridge: Some(electrobun::noop_webview_post_message),
        ..WebviewCallbacks::default()
    };

    let create_result = state.core.create_webview(webview_options).map(|_| ());
    if create_result.is_ok() {
        thread::sleep(Duration::from_millis(300));
    }
    let close_result = state.core.close_window(window_id);
    create_result.and(close_result)
}

fn maybe_auto_run_after_handshake(webview_id: u32) {
    let state = app_state();
    if !state.auto_run_all && state.auto_run_test_name.is_none() {
        return;
    }
    if state.auto_run_triggered.swap(true, Ordering::AcqRel) {
        return;
    }

    if let Some(test_name) = &state.auto_run_test_name {
        eprintln!("[kitchen rust] auto-running test: {test_name}");
        if let Some(test) = find_test_by_name_or_id(test_name) {
            start_single_test(webview_id, None, test);
        } else {
            eprintln!("[kitchen rust] failed to find auto-run test: {test_name}");
        }
        return;
    }

    if state.auto_run_all {
        eprintln!("[kitchen rust] auto-running all automated tests");
        start_all_tests(webview_id, None, false);
    }
}

fn tests_json() -> String {
    let mut entries = Vec::with_capacity(RUST_TESTS.len());
    for test in RUST_TESTS {
        entries.push(format!(
            "{{\"id\":{},\"name\":{},\"category\":{},\"description\":{},\"interactive\":{}}}",
            electrobun::json_string_literal(test.id),
            electrobun::json_string_literal(test.name),
            electrobun::json_string_literal(test.category),
            electrobun::json_string_literal(test.description),
            test.interactive
        ));
    }
    format!("[{}]", entries.join(","))
}

fn test_result_json(test: RustTest, result: &TestRunResult) -> String {
    let error_field = result
        .error
        .as_ref()
        .map(|err| format!(",\"error\":{}", electrobun::json_string_literal(err)))
        .unwrap_or_default();
    format!(
        "{{\"testId\":{},\"name\":{},\"status\":{},\"duration\":{}{} }}",
        electrobun::json_string_literal(test.id),
        electrobun::json_string_literal(test.name),
        electrobun::json_string_literal(result.status),
        result.duration_ms,
        error_field
    )
}

fn send_initial_ui_state(webview_id: u32) {
    send_build_config(webview_id);
    send_update_status(webview_id);
}

fn send_build_config(webview_id: u32) {
    let state = app_state();
    let available_renderers = if state.cef_available {
        "[\"native\",\"cef\"]"
    } else {
        "[\"native\"]"
    };
    let cef_field = state
        .cef_version
        .as_ref()
        .map(|value| format!(",\"cefVersion\":{}", electrobun::json_string_literal(value)))
        .unwrap_or_default();
    let rust_field = state
        .rust_version
        .as_ref()
        .map(|value| format!(",\"rustVersion\":{}", electrobun::json_string_literal(value)))
        .unwrap_or_default();
    let payload = format!(
        "{{\"defaultRenderer\":{},\"availableRenderers\":{},\"mainProcess\":\"rust\"{}{} }}",
        electrobun::json_string_literal(&state.default_renderer),
        available_renderers,
        cef_field,
        rust_field
    );
    send_rpc_message(webview_id, "buildConfig", &payload);
}

fn send_update_status(webview_id: u32) {
    let payload = format!(
        "{{\"status\":\"no-update\",\"currentVersion\":{}}}",
        electrobun::json_string_literal(APP_VERSION)
    );
    send_rpc_message(webview_id, "updateStatus", &payload);
}

fn send_test_log(webview_id: u32, test_id: &str, message: &str) {
    let payload = format!(
        "{{\"testId\":{},\"message\":{}}}",
        electrobun::json_string_literal(test_id),
        electrobun::json_string_literal(message)
    );
    send_rpc_message(webview_id, "testLog", &payload);
}

fn send_rpc_message(webview_id: u32, message_id: &str, payload_json: &str) {
    let packet = format!(
        "{{\"type\":\"message\",\"id\":{},\"payload\":{}}}",
        electrobun::json_string_literal(message_id),
        payload_json
    );
    if let Err(err) = app_state()
        .core
        .send_host_message_to_webview_json(webview_id, &packet)
    {
        eprintln!("[kitchen rust] failed to send RPC message '{message_id}': {err}");
    }
}

fn send_rpc_response_success(webview_id: u32, request_id: u64, payload_json: &str) {
    let packet = format!(
        "{{\"type\":\"response\",\"id\":{},\"success\":true,\"payload\":{}}}",
        request_id, payload_json
    );
    if let Err(err) = app_state()
        .core
        .send_host_message_to_webview_json(webview_id, &packet)
    {
        eprintln!("[kitchen rust] failed to send RPC response #{request_id}: {err}");
    }
}

fn send_rpc_response_error(webview_id: u32, request_id: u64, error_message: &str) {
    let packet = format!(
        "{{\"type\":\"response\",\"id\":{},\"success\":false,\"error\":{}}}",
        request_id,
        electrobun::json_string_literal(error_message)
    );
    if let Err(err) = app_state()
        .core
        .send_host_message_to_webview_json(webview_id, &packet)
    {
        eprintln!("[kitchen rust] failed to send RPC error #{request_id}: {err}");
    }
}

fn json_u64_field(source: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let key_index = source.find(&needle)?;
    let after_key = &source[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let after_colon = after_key[colon_index + 1..].trim_start();
    let digits: String = after_colon
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    digits.parse().ok()
}
