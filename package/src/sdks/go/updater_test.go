//go:build cgo

package electrobun

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// This dynamically loaded fixture exercises the actual C ABI, including owned
// response strings. Other core entry points are stubs and are never invoked.
const updaterFixture = `
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char* fixture_copy(const char* value) {
    size_t size = strlen(value) + 1;
    char* copy = malloc(size);
    if (copy) memcpy(copy, value, size);
    return copy;
}

static int configurations, requests, frees, stops, shutdowns, phase, approved_reads;
static const char* last_error = "";
FIXTURE_EXPORT const char* electrobun_core_last_error(void) { return last_error; }
FIXTURE_EXPORT void setExitOnLastWindowClosed(bool value) { (void)value; }
FIXTURE_EXPORT void setQuitRequestedHandler(void (*callback)(void)) { (void)callback; }
FIXTURE_EXPORT int electrobun_core_run_main_thread(const char* identifier, const char* name, const char* channel, int argc) { return 0; }
FIXTURE_EXPORT void stopEventLoop(void) { stops++; }
FIXTURE_EXPORT void freeCoreString(char* value) { frees++; free(value); }
FIXTURE_EXPORT bool updaterConfigure(const char* value) {
    configurations++;
    if (strstr(value, "reject")) { last_error = "fixture configuration rejected"; return false; }
    if (!strstr(value, "\"schemaVersion\":1") || !strstr(value, "\"exeDir\":") || !strstr(value, "\"resourcesDir\":")) return false;
    if (strstr(value, "installationId") || strstr(value, "channelRoot") || strstr(value, "manifest")) return false;
    last_error = "";
    return true;
}
FIXTURE_EXPORT char* updaterRequest(const char* value) {
    requests++;
    if (strstr(value, "badJSON")) return fixture_copy("{");
    if (strstr(value, "badSchema")) return fixture_copy("{\"schemaVersion\":2}");
    if (strstr(value, "badID")) return fixture_copy("{\"schemaVersion\":1,\"accepted\":true,\"operationId\":null,\"error\":null}");
    if (strstr(value, "requestApply")) phase = 1;
    if (strstr(value, "approveApply")) {
        if (!strstr(value, "\"operationId\":\"operation-1\"") || !strstr(value, "\"approvalId\":\"approval-1\""))
            return fixture_copy("{\"schemaVersion\":1,\"accepted\":false,\"operationId\":null,\"error\":\"stale approval\"}");
        if (strstr(value, "\"approved\":false")) phase = 3;
        else if (strstr(value, "\"approved\":true")) { phase = 2; approved_reads = 0; }
        else return fixture_copy("{\"schemaVersion\":1,\"accepted\":false,\"operationId\":null,\"error\":\"missing decision\"}");
    }
    return fixture_copy("{\"schemaVersion\":1,\"accepted\":true,\"operationId\":\"operation-1\",\"error\":null}");
}
FIXTURE_EXPORT char* updaterGetState(void) {
    char response[4096];
    const char* approval = phase == 1 ? "{\"id\":\"approval-1\",\"preparedHash\":\"next-hash\"}" : "null";
    const char* state = phase == 1 ? "awaitingApproval" : phase == 2 ? "completed" : phase == 3 ? "cancelled" : "idle";
    bool ready = phase == 2 && approved_reads++ > 0;
    snprintf(response, sizeof(response),
      "{\"schemaVersion\":1,\"revision\":%d,\"operationId\":%s,\"operation\":%s,\"operationState\":\"%s\","
      "\"localInfo\":{\"version\":\"%d\",\"hash\":\"%d\",\"baseUrl\":\"https://example.test/updates\",\"channel\":\"canary\",\"name\":\"Example\",\"displayName\":\"Example App\",\"identifier\":\"test.app\",\"managed\":{\"appId\":\"app-1\",\"baseUrl\":\"https://example.test\"},\"updateAuthority\":\"direct\"},"
      "\"updateInfo\":{\"version\":\"2.0.0\",\"hash\":\"next-hash\",\"updateAvailable\":true,\"updateReady\":true,\"error\":\"\"},"
      "\"approval\":%s,\"quitReady\":%s,\"channelRoot\":\"stops=%d,shutdowns=%d\","
      "\"operations\":[{\"operationId\":\"previous\",\"operation\":\"check\",\"state\":\"completed\",\"error\":null,\"updateInfo\":{\"version\":\"2.0.0\",\"hash\":\"next-hash\",\"updateAvailable\":true,\"updateReady\":false,\"error\":\"\"}}]}",
      frees, phase ? "\"operation-1\"" : "null", phase ? "\"requestApply\"" : "null", state,
      configurations, requests, approval, ready ? "true" : "false", stops, shutdowns);
    return fixture_copy(response);
}
FIXTURE_EXPORT char* updaterGetEvents(uint64_t after, uint32_t limit) {
    char response[1024];
    snprintf(response, sizeof(response), "{\"schemaVersion\":1,\"entries\":[{\"sequence\":%llu,\"operationId\":null,\"status\":\"download-progress\",\"message\":\"progress\",\"timestamp\":1700000000123,\"details\":{\"progress\":0.5,\"bytesDownloaded\":4294967296,\"totalBytes\":8589934592,\"usedPatchPath\":false,\"exitCode\":null}}],\"nextSequence\":%llu,\"oldestSequence\":%u,\"overflow\":true}", (unsigned long long)after + 1, (unsigned long long)after + 1, limit);
    return fixture_copy(response);
}
FIXTURE_EXPORT void updaterShutdown(void) { shutdowns++; }
`

func loadUpdaterFixture(t *testing.T, includeUpdater bool) *Core {
	t.Helper()
	compilerName := os.Getenv("ELECTROBUN_TEST_ZIG")
	var compilerArgs []string
	explicitCompiler := compilerName != ""
	if explicitCompiler {
		compilerArgs = []string{"cc"}
	} else {
		compilerName = "cc"
	}
	compiler, err := exec.LookPath(compilerName)
	if err != nil {
		if explicitCompiler {
			t.Fatalf("ELECTROBUN_TEST_ZIG executable %q unavailable: %v", compilerName, err)
		}
		t.Skip("C compiler unavailable for ABI fixture")
	}
	dir := t.TempDir()
	var source strings.Builder
	source.WriteString(`#ifdef _WIN32
#define FIXTURE_EXPORT __declspec(dllexport)
#else
#define FIXTURE_EXPORT
#endif
`)
	implemented := map[string]bool{
		"electrobun_core_last_error": true, "setExitOnLastWindowClosed": true,
		"setQuitRequestedHandler": true, "electrobun_core_run_main_thread": true,
		"stopEventLoop": true, "freeCoreString": true,
	}
	if includeUpdater {
		source.WriteString(updaterFixture)
	} else {
		source.WriteString(`#include <stdbool.h>
FIXTURE_EXPORT const char* electrobun_core_last_error(void) { return ""; }
FIXTURE_EXPORT void setExitOnLastWindowClosed(bool value) {}
FIXTURE_EXPORT void setQuitRequestedHandler(void (*callback)(void)) {}
FIXTURE_EXPORT int electrobun_core_run_main_thread(const char* a, const char* b, const char* c, int d) { return 0; }
FIXTURE_EXPORT void stopEventLoop(void) {}
FIXTURE_EXPORT void freeCoreString(char* value) {}
`)
	}
	for _, name := range requiredSymbols {
		if !implemented[name] {
			fmt.Fprintf(&source, "FIXTURE_EXPORT void %s(void) {}\n", name)
		}
	}
	path := filepath.Join(dir, "fixture.c")
	if err := os.WriteFile(path, []byte(source.String()), 0600); err != nil {
		t.Fatal(err)
	}
	flag := "-shared"
	if runtime.GOOS == "darwin" {
		flag = "-dynamiclib"
	}
	compilerArgs = append(compilerArgs, flag)
	if runtime.GOOS != "windows" {
		compilerArgs = append(compilerArgs, "-fPIC")
	}
	compilerArgs = append(compilerArgs, path, "-o", filepath.Join(dir, coreLibraryName()))
	output, err := exec.Command(compiler, compilerArgs...).CombinedOutput()
	if err != nil {
		t.Fatalf("build ABI fixture: %v\n%s", err, output)
	}
	core, err := loadCoreFromBundle(BundlePaths{ExeDir: dir, ResourcesDir: filepath.Join(dir, "Resources")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// LoadCore installs a Go quit closure containing this handle. Clear it
		// before Windows releases the fixture DLL and its function pointers.
		setQuitRequestedHandler(nil)
		releaseUpdaterFixture(t, core)
	})
	return core
}

func TestUpdaterLazyConfigurationAndOwnedResponses(t *testing.T) {
	core := loadUpdaterFixture(t, true)
	state, err := core.UpdaterGetState()
	if err != nil {
		t.Fatal(err)
	}
	if state.LocalInfo.Version != "1" || state.LocalInfo.Hash != "0" || state.Revision != 0 {
		t.Fatalf("load must not configure or request updates; first getter configures once: %+v", state)
	}
	if state.OperationID != "" || state.Operation != "" || state.Approval != nil || state.QuitReady ||
		state.LocalInfo.Managed == nil || state.LocalInfo.Managed.AppID != "app-1" || len(state.Operations) != 1 || state.Operations[0].State != UpdaterCompleted {
		t.Fatalf("unexpected typed state: %+v", state)
	}
	state, err = core.UpdaterGetState()
	if err != nil || state.Revision != 1 || state.LocalInfo.Version != "1" {
		t.Fatalf("response must be freed exactly once and configuration reused: %+v, %v", state, err)
	}
	for _, action := range []string{"badJSON", "badSchema", "badID"} {
		if _, err := core.updaterSend(updaterRequest{Action: action}); err == nil {
			t.Fatalf("expected invalid %s response error", action)
		}
	}
	state, err = core.UpdaterGetState()
	if err != nil || state.Revision != 5 {
		t.Fatalf("invalid response allocations must also be freed: %+v, %v", state, err)
	}
	batch, err := core.UpdaterGetEvents(1<<40, 17)
	if err != nil {
		t.Fatal(err)
	}
	if batch.NextSequence != 1<<40+1 || batch.OldestSequence != 17 || !batch.Overflow || len(batch.Entries) != 1 {
		t.Fatalf("event ABI must retain uint64 cursors and uint32 limits: %+v", batch)
	}
	details := batch.Entries[0].Details
	if batch.Entries[0].Status != "download-progress" || details == nil || details.BytesDownloaded == nil || *details.BytesDownloaded != 1<<32 ||
		details.UsedPatchPath == nil || *details.UsedPatchPath || details.ExitCode != nil {
		t.Fatalf("unexpected typed event details: %+v", details)
	}
}

func TestUpdaterApplyApprovalDoesNotQuit(t *testing.T) {
	core := loadUpdaterFixture(t, true)
	result, err := core.UpdaterRequestApply()
	if err != nil || !result.Accepted || result.OperationID != "operation-1" {
		t.Fatalf("unexpected apply request: %+v, %v", result, err)
	}
	state, err := core.UpdaterGetState()
	if err != nil || state.OperationState != UpdaterAwaitingApproval || state.Approval == nil || state.QuitReady {
		t.Fatalf("apply must await application approval: %+v, %v", state, err)
	}
	if result, err = core.UpdaterApproveApply(state.OperationID, "stale", true); err == nil || result.Accepted || result.Error != "stale approval" {
		t.Fatalf("core approval errors must be preserved: %+v, %v", result, err)
	}
	if _, err := core.UpdaterApproveApply(state.OperationID, state.Approval.ID, false); err != nil {
		t.Fatalf("false approval must be sent explicitly: %v", err)
	}
	state, err = core.UpdaterGetState()
	if err != nil || state.OperationState != UpdaterCancelled || state.QuitReady {
		t.Fatalf("veto should not permit teardown: %+v, %v", state, err)
	}
	if _, err := core.UpdaterRequestApply(); err != nil {
		t.Fatal(err)
	}
	if _, err := core.UpdaterApproveApply("operation-1", "approval-1", true); err != nil {
		t.Fatal(err)
	}
	state, err = core.UpdaterGetState()
	if err != nil || state.QuitReady {
		t.Fatalf("accepted approval alone must not imply quit readiness: %+v, %v", state, err)
	}
	state, err = core.UpdaterGetState()
	if err != nil || !state.QuitReady || state.ChannelRoot != "stops=0,shutdowns=0" {
		t.Fatalf("readiness is reported without changing normal quit policy: %+v, %v", state, err)
	}
}

func TestUpdaterShutdownAndConfigurationErrors(t *testing.T) {
	core := loadUpdaterFixture(t, true)
	if err := core.UpdaterConfigure(BundlePaths{ExeDir: "fixture", ResourcesDir: "reject"}); err == nil || !strings.Contains(err.Error(), "fixture configuration rejected") {
		t.Fatalf("configuration error must retain native cause: %v", err)
	}
	if err := core.UpdaterConfigure(BundlePaths{ExeDir: "fixture", ResourcesDir: "Resources"}); err != nil {
		t.Fatal(err)
	}
	if err := core.RunMainThread(AppInfo{Identifier: "test.app", Name: "Example", Channel: "dev"}); err != nil {
		t.Fatal(err)
	}
	state, err := core.UpdaterGetState()
	if err != nil || state.ChannelRoot != "stops=0,shutdowns=1" {
		t.Fatalf("returning from the event loop must shutdown the updater: %+v, %v", state, err)
	}
	if err := core.UpdaterShutdown(); err != nil {
		t.Fatal(err)
	}
}

func TestUpdaterLoopReturnWithoutConfigurationDoesNotShutdown(t *testing.T) {
	core := loadUpdaterFixture(t, true)
	if err := core.RunMainThread(AppInfo{Identifier: "test.app", Name: "Example", Channel: "dev"}); err != nil {
		t.Fatal(err)
	}
	state, err := core.UpdaterGetState()
	if err != nil || state.ChannelRoot != "stops=0,shutdowns=0" || state.LocalInfo.Version != "1" || state.LocalInfo.Hash != "0" {
		t.Fatalf("loop return must leave an unused updater alone: %+v, %v", state, err)
	}
}

func TestUpdaterOlderCoreReportsUnavailable(t *testing.T) {
	core := loadUpdaterFixture(t, false)
	if _, err := core.UpdaterCheck(); !errors.Is(err, ErrUpdaterUnavailable) {
		t.Fatalf("expected explicit unavailable error: %v", err)
	}
	if _, err := core.UpdaterGetState(); !errors.Is(err, ErrUpdaterUnavailable) {
		t.Fatalf("expected explicit unavailable error: %v", err)
	}
	if _, err := core.UpdaterGetEvents(0, 10); !errors.Is(err, ErrUpdaterUnavailable) {
		t.Fatalf("expected explicit unavailable error: %v", err)
	}
	if err := core.UpdaterConfigure(BundlePaths{}); !errors.Is(err, ErrUpdaterUnavailable) {
		t.Fatalf("expected explicit unavailable error: %v", err)
	}
	if err := core.UpdaterShutdown(); !errors.Is(err, ErrUpdaterUnavailable) {
		t.Fatalf("expected explicit unavailable error: %v", err)
	}
}
