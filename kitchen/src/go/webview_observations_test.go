package main

import "testing"

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
