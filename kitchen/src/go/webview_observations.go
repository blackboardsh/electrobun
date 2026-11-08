package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type webviewObservation struct {
	webviewID uint32
	eventName string
	detail    string
}

// Closing a Windows window posts WM_CLOSE. Earlier callbacks can still arrive
// after the next test starts, so retain evidence by view, event and detail until
// reset. A later event must not erase a navigation that already happened.
// The harness protects this store with callbacksMu.
type webviewObservations struct {
	events map[webviewObservation]struct{}
}

func (observations *webviewObservations) clear() {
	clear(observations.events)
}

func (observations *webviewObservations) record(webviewID uint32, eventName, detail string) {
	if observations.events == nil {
		observations.events = make(map[webviewObservation]struct{})
	}
	observations.events[webviewObservation{webviewID, eventName, detail}] = struct{}{}
}

func (observations *webviewObservations) contains(webviewID uint32, eventName, detail string) bool {
	for event := range observations.events {
		if event.webviewID == webviewID && event.eventName == eventName && strings.Contains(event.detail, detail) {
			return true
		}
	}
	return false
}

// Navigation details are raw URLs on Linux/macOS and JSON objects on Windows.
// Match only the entire URL, never a redirect target embedded in source HTML
// or another JSON field.
func (observations *webviewObservations) containsURL(webviewID uint32, eventName, url string) bool {
	for event := range observations.events {
		if event.webviewID != webviewID || event.eventName != eventName {
			continue
		}
		if event.detail == url {
			return true
		}
		var payload map[string]json.RawMessage
		var observedURL *string
		if json.Unmarshal([]byte(event.detail), &payload) == nil &&
			json.Unmarshal(payload["url"], &observedURL) == nil && observedURL != nil && *observedURL == url {
			return true
		}
	}
	return false
}

// Wait for the target document's load event before submitting a one-shot script.
// The observer must match the complete URL, as containsURL does, and must not
// consume events belonging to other windows or an earlier document.
func waitForWebviewDocumentReady(webviewID uint32, expectedURL string, timeout time.Duration, observed func(uint32, string, string) bool) error {
	started := time.Now()
	deadline := started.Add(timeout)
	for {
		ready := observed(webviewID, "dom-ready", expectedURL)
		elapsed := time.Since(started)
		if ready && elapsed <= timeout {
			return nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("timed out waiting for webview %d document %q dom-ready after %s", webviewID, expectedURL, elapsed)
		}
		time.Sleep(min(25*time.Millisecond, remaining))
	}
}
