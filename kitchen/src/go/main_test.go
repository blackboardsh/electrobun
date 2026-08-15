package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestRPCStringParamReadsRequestParams(t *testing.T) {
	var packet rpcPacket
	if err := json.Unmarshal([]byte(`{"type":"request","id":7,"method":"runTest","params":{"testId":"go-webview-tag-playground"}}`), &packet); err != nil {
		t.Fatal(err)
	}

	if got := rpcStringParam(packet, "testId"); got != "go-webview-tag-playground" {
		t.Fatalf("rpcStringParam(testId) = %q, want %q", got, "go-webview-tag-playground")
	}
}

func TestRPCStringParamDoesNotReadTopLevelFields(t *testing.T) {
	var packet rpcPacket
	if err := json.Unmarshal([]byte(`{"type":"request","id":7,"method":"runTest","testId":"stale-top-level-value","params":{}}`), &packet); err != nil {
		t.Fatal(err)
	}

	if got := rpcStringParam(packet, "testId"); got != "" {
		t.Fatalf("rpcStringParam(testId) = %q, want an empty value", got)
	}
}

func TestRPCOptionalStringParamPreservesEmptyValue(t *testing.T) {
	var packet rpcPacket
	if err := json.Unmarshal([]byte(`{"type":"request","id":8,"method":"setTestRunnerPreferences","params":{"searchQuery":""}}`), &packet); err != nil {
		t.Fatal(err)
	}

	value, present, err := rpcOptionalStringParam(packet, "searchQuery")
	if err != nil {
		t.Fatal(err)
	}
	if !present || value != "" {
		t.Fatalf("rpcOptionalStringParam(searchQuery) = %q, %t; want empty and present", value, present)
	}
}

func TestRPCMessagePacketReadsStringIDAndNestedPayload(t *testing.T) {
	var packet rpcMessagePacket
	if err := json.Unmarshal([]byte(`{"type":"message","id":"logToBun","payload":{"msg":"hello"}}`), &packet); err != nil {
		t.Fatal(err)
	}
	if packet.ID != "logToBun" || stringField(rawParams(packet.Payload), "msg") != "hello" {
		t.Fatalf("message packet = %#v", packet)
	}
}

func TestInteractiveTestsJSONIncludesInstructions(t *testing.T) {
	var tests []struct {
		ID           string   `json:"id"`
		Interactive  bool     `json:"interactive"`
		Instructions []string `json:"instructions"`
	}
	if err := json.Unmarshal([]byte(testsJSON()), &tests); err != nil {
		t.Fatal(err)
	}

	interactiveCount := 0
	for _, test := range tests {
		if !test.Interactive {
			continue
		}
		interactiveCount++
		if len(test.Instructions) == 0 {
			t.Errorf("interactive test %q has no instructions", test.ID)
		}
	}
	if interactiveCount != 8 {
		t.Fatalf("found %d interactive tests, want 8", interactiveCount)
	}
}

func TestPrepareMenuJSONNormalizesNativeMenuContract(t *testing.T) {
	menuJSON, registry, err := prepareMenuJSON(`[{"submenu":[{"role":"selectAll"},{"type":"separator"},{"label":"Run","action":"run","data":{"value":42}}]}]`)
	if err != nil {
		t.Fatal(err)
	}
	var menu []map[string]any
	if err := json.Unmarshal([]byte(menuJSON), &menu); err != nil {
		t.Fatal(err)
	}
	items := menu[0]["submenu"].([]any)
	role := items[0].(map[string]any)
	if role["label"] != "Select All" || role["role"] != "selectAll" {
		t.Fatalf("role item = %#v, want normalized role and label", role)
	}
	if role["enabled"] != true || role["checked"] != false || role["hidden"] != false {
		t.Fatalf("role defaults = %#v", role)
	}
	if _, ok := role["action"]; ok {
		t.Fatalf("role item unexpectedly has an action: %#v", role)
	}
	divider := items[1].(map[string]any)
	if len(divider) != 1 || divider["type"] != "divider" {
		t.Fatalf("divider = %#v, want native divider", divider)
	}
	custom := items[2].(map[string]any)
	action, data, ok := registry.take(custom["action"].(string))
	if !ok || action != "run" {
		t.Fatalf("decoded custom action = %q, %#v, %t", action, data, ok)
	}
	if data.(map[string]any)["value"] != float64(42) {
		t.Fatalf("custom data = %#v", data)
	}
}

func TestMenuRouteMultiplexerKeepsApplicationAndContextTargets(t *testing.T) {
	resetMenuRoutesForTest()
	t.Cleanup(resetMenuRoutesForTest)

	applicationID := registerMenuRoute(11, "menuClicked")
	applicationJSON, applicationRegistry, err := prepareMenuJSON(`[{"label":"App","action":"app-action"}]`, applicationID)
	if err != nil {
		t.Fatal(err)
	}
	bindMenuRoute(applicationID, applicationRegistry)
	activateMenuRoute("application", applicationID)

	contextID := registerMenuRoute(22, "contextMenuClicked")
	contextJSON, contextRegistry, err := prepareMenuJSON(`[{"label":"Context","action":"context-action"}]`, contextID)
	if err != nil {
		t.Fatal(err)
	}
	bindMenuRoute(contextID, contextRegistry)
	activateMenuRoute("context", contextID)

	applicationRoute, applicationAction, ok := resolveMenuRoute(firstMenuAction(t, applicationJSON))
	if !ok || applicationRoute.webviewID != 11 || applicationRoute.messageID != "menuClicked" || applicationAction != "app-action" {
		t.Fatalf("application route = %#v, %q, %t", applicationRoute, applicationAction, ok)
	}
	contextRoute, contextAction, ok := resolveMenuRoute(firstMenuAction(t, contextJSON))
	if !ok || contextRoute.webviewID != 22 || contextRoute.messageID != "contextMenuClicked" || contextAction != "context-action" {
		t.Fatalf("context route = %#v, %q, %t", contextRoute, contextAction, ok)
	}
}

func TestPendingMenuRouteDoesNotRemoveActiveRoute(t *testing.T) {
	resetMenuRoutesForTest()
	t.Cleanup(resetMenuRoutesForTest)

	activeID := registerMenuRoute(11, "menuClicked")
	activeJSON, activeRegistry, err := prepareMenuJSON(`[{"label":"Active","action":"active"}]`, activeID)
	if err != nil {
		t.Fatal(err)
	}
	bindMenuRoute(activeID, activeRegistry)
	activateMenuRoute("application", activeID)

	pendingID := registerMenuRoute(22, "menuClicked")
	if _, _, ok := resolveMenuRoute(firstMenuAction(t, activeJSON)); !ok {
		t.Fatal("reserving a replacement removed the active menu route")
	}
	removeMenuRoute(pendingID)
	if _, _, ok := resolveMenuRoute(firstMenuAction(t, activeJSON)); !ok {
		t.Fatal("failed replacement removed the active menu route")
	}
}

func TestOpenFileDialogOptionsPreserveFalseAndExpandTilde(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "Users", "tester")
	options, err := openFileDialogOptionsFromParams(json.RawMessage(`{
		"startingFolder":"~/Documents",
		"allowedFileTypes":"png,jpg",
		"canChooseFiles":false,
		"canChooseDirectory":false,
		"allowsMultipleSelection":false
	}`), home)
	if err != nil {
		t.Fatal(err)
	}
	if options.StartingFolder != filepath.Join(home, "Documents") || options.AllowedFileTypes != "png,jpg" {
		t.Fatalf("file dialog paths/types = %#v", options)
	}
	if options.CanChooseFiles || options.CanChooseDirectory || options.AllowsMultipleSelection {
		t.Fatalf("explicit false options were not preserved: %#v", options)
	}

	defaults, err := openFileDialogOptionsFromParams(json.RawMessage(`{}`), home)
	if err != nil {
		t.Fatal(err)
	}
	if !defaults.CanChooseFiles || !defaults.CanChooseDirectory || !defaults.AllowsMultipleSelection || defaults.AllowedFileTypes != "*" {
		t.Fatalf("file dialog defaults = %#v", defaults)
	}
}

func TestNormalizeFileDialogResultPreservesCommaInPath(t *testing.T) {
	payload, err := normalizeFileDialogResult(`["/tmp/report,final.txt"]`)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	if err := json.Unmarshal([]byte(payload), &paths); err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || paths[0] != "/tmp/report,final.txt" {
		t.Fatalf("paths = %#v", paths)
	}
	if _, err := normalizeFileDialogResult(`[1]`); err == nil {
		t.Fatal("non-string file dialog result unexpectedly succeeded")
	}
	if empty, err := normalizeFileDialogResult(""); err != nil || empty != "[]" {
		t.Fatalf("empty result = %q, %v", empty, err)
	}
}

func TestInteractivePlaygroundRPCMethodsHaveGoDispatchers(t *testing.T) {
	playgrounds := []string{
		"webviewtag", "wgpu-tag", "application-menu", "context-menu",
		"file-dialog", "shortcuts", "quit-test",
	}
	requestPattern := regexp.MustCompile(`request\.([A-Za-z][A-Za-z0-9_]*)`)
	messagePattern := regexp.MustCompile(`message\.([A-Za-z][A-Za-z0-9_]*)`)
	mainSource, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	requestDispatcher := sourceBlock(t, string(mainSource), "func handleRPCRequest", "func rawParams")
	messageDispatcher := sourceBlock(t, string(mainSource), "func handleRPCMessage", "func handleRPCRequest")
	for _, playground := range playgrounds {
		source, err := os.ReadFile(filepath.Join("..", "playgrounds", playground, "index.ts"))
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range requestPattern.FindAllStringSubmatch(string(source), -1) {
			if !strings.Contains(requestDispatcher, `case "`+match[1]+`"`) {
				t.Errorf("%s request %q has no Go dispatcher", playground, match[1])
			}
		}
		for _, match := range messagePattern.FindAllStringSubmatch(string(source), -1) {
			if !strings.Contains(messageDispatcher, `case "`+match[1]+`"`) {
				t.Errorf("%s message %q has no Go dispatcher", playground, match[1])
			}
		}
	}
}

func firstMenuAction(t *testing.T, source string) string {
	t.Helper()
	var menu []map[string]any
	if err := json.Unmarshal([]byte(source), &menu); err != nil {
		t.Fatal(err)
	}
	return menu[0]["action"].(string)
}

func sourceBlock(t *testing.T, source, startMarker, endMarker string) string {
	t.Helper()
	start := strings.Index(source, startMarker)
	if start < 0 {
		t.Fatalf("source marker %q not found", startMarker)
	}
	endOffset := strings.Index(source[start+len(startMarker):], endMarker)
	if endOffset < 0 {
		t.Fatalf("source marker %q not found after %q", endMarker, startMarker)
	}
	return source[start : start+len(startMarker)+endOffset]
}

func resetMenuRoutesForTest() {
	menuRoutes.Lock()
	menuRoutes.nextID = 0
	menuRoutes.application = ""
	menuRoutes.context = ""
	menuRoutes.routes = map[string]menuRoute{}
	menuRoutes.Unlock()
}
