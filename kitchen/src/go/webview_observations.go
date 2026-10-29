package main

import "strings"

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

func (observations *webviewObservations) equals(webviewID uint32, eventName, detail string) bool {
	_, found := observations.events[webviewObservation{webviewID, eventName, detail}]
	return found
}
