package main

import "testing"

func TestHTMLContainingRedirectTargetIsNotCompletedNavigation(t *testing.T) {
	var observations webviewObservations
	const target = "views://test-harness/index.html?loadHtml=go-rendered"
	observations.record(18, "did-navigate", "data:text/html,<script>location.href='"+target+"'</script>")
	if !observations.contains(18, "did-navigate", target) {
		t.Fatal("substring search should remain available for event payloads")
	}
	if observations.containsURL(18, "did-navigate", target) {
		t.Fatal("HTML document containing the target was mistaken for completed navigation")
	}
	observations.record(19, "did-navigate", target)
	observations.record(18, "will-navigate", target)
	if observations.containsURL(18, "did-navigate", target) {
		t.Fatal("wrong view or event completed the expected navigation")
	}
	observations.record(18, "did-navigate", target)
	if !observations.containsURL(18, "did-navigate", target) {
		t.Fatal("exact target navigation was not observed")
	}
}

func TestWindowsJSONNavigationMatchesOnlyCompleteTopLevelURL(t *testing.T) {
	const target = "views://test-harness/index.html?loadHtml=go-rendered"
	var observations webviewObservations
	detail := `{"url":"` + target + `"}`
	observations.record(19, "did-navigate", detail)
	observations.record(18, "will-navigate", detail)
	if observations.containsURL(18, "did-navigate", target) {
		t.Fatal("wrong view or event completed the expected navigation")
	}
	observations.record(18, "did-navigate", detail)
	if !observations.containsURL(18, "did-navigate", target) {
		t.Fatal("Windows JSON navigation was not observed")
	}
	for _, detail := range []string{
		`{"url":"data:text/html,<script>location='` + target + `'</script>"}`,
		`{"url":"about:blank","expected":"` + target + `"}`,
		`{"nested":{"url":"` + target + `"}}`,
		`[{"url":"` + target + `"}]`,
		`{"url":"` + target + `#other"}`,
		`{"url":"` + target + `"} trailing`,
		`"` + target + `"`,
		`{"url":null}`,
		`{"url":42}`,
	} {
		observations.clear()
		observations.record(18, "did-navigate", detail)
		if observations.containsURL(18, "did-navigate", target) {
			t.Fatalf("non-target payload completed navigation: %s", detail)
		}
	}
}

func TestNavigationJSONDecodesEscapedURLs(t *testing.T) {
	var observations webviewObservations
	observations.record(18, "did-navigate", ` { "url" : "views:\/\/test-harness\/index.html?q=\u2713", "extra": true } `)
	if !observations.containsURL(18, "did-navigate", "views://test-harness/index.html?q=✓") {
		t.Fatal("escaped URL was not decoded")
	}
}

func TestOldViewsLateCallbackCannotCompleteNextTest(t *testing.T) {
	var observations webviewObservations
	observations.record(15, "will-navigate", "about:blank")
	observations.clear()
	observations.record(15, "dom-ready", "about:blank")
	if observations.contains(16, "dom-ready", "") {
		t.Fatal("old view completed the current view's test")
	}
	observations.record(16, "dom-ready", "views://test-harness/index.html")
	if !observations.contains(16, "dom-ready", "") {
		t.Fatal("current view's callback was lost")
	}
}

func TestLaterEventCannotEraseNavigationCommitURL(t *testing.T) {
	var observations webviewObservations
	observations.record(18, "did-commit-navigation", "views://zig/index.html")
	observations.record(18, "dom-ready", "views://test-harness/index.html")
	if !observations.contains(18, "did-commit-navigation", "views://zig") {
		t.Fatal("late bridge message erased navigation commit evidence")
	}
}

func TestAnotherViewsSameEventCannotReplaceTargetEvidence(t *testing.T) {
	var observations webviewObservations
	observations.record(18, "did-commit-navigation", "views://zig/index.html")
	observations.record(17, "did-commit-navigation", "views://test-harness/index.html")
	if !observations.contains(18, "did-commit-navigation", "views://zig") {
		t.Fatal("another view erased target evidence")
	}
	if observations.contains(17, "did-commit-navigation", "views://zig") {
		t.Fatal("target evidence was attributed to another view")
	}
}

func TestLateSameEventOldDocumentCannotEraseObservedEvidence(t *testing.T) {
	var observations webviewObservations
	observations.record(18, "did-commit-navigation", "views://zig/index.html")
	observations.record(18, "did-commit-navigation", "views://test-harness/index.html")
	if !observations.contains(18, "did-commit-navigation", "views://zig") {
		t.Fatal("old document replaced matching observed evidence")
	}
	observations.record(18, "did-commit-navigation", "views://zig/index.html")
	if len(observations.events) != 2 {
		t.Fatalf("duplicate callbacks used extra storage: got %d entries", len(observations.events))
	}
}

func TestNavigationRequiresTargetEventAndURLTogether(t *testing.T) {
	var observations webviewObservations
	observations.record(18, "did-commit-navigation", "views://test-harness/index.html")
	observations.record(18, "will-navigate", "views://zig/index.html")
	if observations.contains(18, "did-commit-navigation", "views://zig") {
		t.Fatal("expected URL from a different event completed navigation commit")
	}
	observations.record(18, "did-commit-navigation", "views://zig/index.html")
	if !observations.contains(18, "did-commit-navigation", "views://zig") {
		t.Fatal("matching event and URL were not observed")
	}
}

func TestResetRemovesPriorEvidenceForSameView(t *testing.T) {
	var observations webviewObservations
	observations.record(18, "did-navigate", "views://zig/index.html")
	observations.clear()
	if observations.contains(18, "did-navigate", "views://zig") {
		t.Fatal("reset retained evidence from a prior test")
	}
}
