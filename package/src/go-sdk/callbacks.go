package electrobun

/*
#include <stdint.h>
*/
import "C"

import "sync"

var callbackMu sync.RWMutex

var windowCallbackRegistry = map[uint32]WindowCallbacks{}
var webviewCallbackRegistry = map[uint32]WebviewCallbacks{}

var statusItemHandler StatusItemHandler
var globalShortcutHandler func(string)
var urlOpenHandler func(string)
var appReopenHandler func()
var quitRequestedHandler func()

func registerWindowCallbacks(windowID uint32, callbacks WindowCallbacks) {
	if callbacks.Close == nil &&
		callbacks.Move == nil &&
		callbacks.Resize == nil &&
		callbacks.Focus == nil &&
		callbacks.Blur == nil &&
		callbacks.Key == nil {
		return
	}
	callbackMu.Lock()
	windowCallbackRegistry[windowID] = callbacks
	callbackMu.Unlock()
}

func forgetWindowCallbacks(windowID uint32) {
	callbackMu.Lock()
	delete(windowCallbackRegistry, windowID)
	callbackMu.Unlock()
}

func registerWebviewCallbacks(webviewID uint32, callbacks WebviewCallbacks) {
	if callbacks.DecideNavigation == nil &&
		callbacks.Event == nil &&
		callbacks.EventBridge == nil &&
		callbacks.HostBridge == nil &&
		callbacks.InternalBridge == nil {
		return
	}
	callbackMu.Lock()
	webviewCallbackRegistry[webviewID] = callbacks
	callbackMu.Unlock()
}

func forgetWebviewCallbacks(webviewID uint32) {
	callbackMu.Lock()
	delete(webviewCallbackRegistry, webviewID)
	callbackMu.Unlock()
}

func setStatusItemHandler(handler StatusItemHandler) {
	callbackMu.Lock()
	statusItemHandler = handler
	callbackMu.Unlock()
}

func setGlobalShortcutHandler(handler func(string)) {
	callbackMu.Lock()
	globalShortcutHandler = handler
	callbackMu.Unlock()
}

func setURLOpenHandler(handler func(string)) {
	callbackMu.Lock()
	urlOpenHandler = handler
	callbackMu.Unlock()
}

func setAppReopenHandler(handler func()) {
	callbackMu.Lock()
	appReopenHandler = handler
	callbackMu.Unlock()
}

func setQuitRequestedHandler(handler func()) {
	callbackMu.Lock()
	quitRequestedHandler = handler
	callbackMu.Unlock()
}

//export electrobunWindowCloseHandler
func electrobunWindowCloseHandler(windowID C.uint32_t) {
	id := uint32(windowID)
	callbackMu.RLock()
	handler := windowCallbackRegistry[id].Close
	callbackMu.RUnlock()
	if handler != nil {
		handler(id)
	}
}

//export electrobunWindowMoveHandler
func electrobunWindowMoveHandler(windowID C.uint32_t, x C.double, y C.double) {
	id := uint32(windowID)
	callbackMu.RLock()
	handler := windowCallbackRegistry[id].Move
	callbackMu.RUnlock()
	if handler != nil {
		handler(id, float64(x), float64(y))
	}
}

//export electrobunWindowResizeHandler
func electrobunWindowResizeHandler(windowID C.uint32_t, x C.double, y C.double, width C.double, height C.double) {
	id := uint32(windowID)
	callbackMu.RLock()
	handler := windowCallbackRegistry[id].Resize
	callbackMu.RUnlock()
	if handler != nil {
		handler(id, float64(x), float64(y), float64(width), float64(height))
	}
}

//export electrobunWindowFocusHandler
func electrobunWindowFocusHandler(windowID C.uint32_t) {
	id := uint32(windowID)
	callbackMu.RLock()
	handler := windowCallbackRegistry[id].Focus
	callbackMu.RUnlock()
	if handler != nil {
		handler(id)
	}
}

//export electrobunWindowBlurHandler
func electrobunWindowBlurHandler(windowID C.uint32_t) {
	id := uint32(windowID)
	callbackMu.RLock()
	handler := windowCallbackRegistry[id].Blur
	callbackMu.RUnlock()
	if handler != nil {
		handler(id)
	}
}

//export electrobunWindowKeyHandler
func electrobunWindowKeyHandler(windowID C.uint32_t, key C.uint32_t, modifiers C.uint32_t, eventType C.uint32_t, characters C.uint32_t) {
	id := uint32(windowID)
	callbackMu.RLock()
	handler := windowCallbackRegistry[id].Key
	callbackMu.RUnlock()
	if handler != nil {
		handler(id, uint32(key), uint32(modifiers), uint32(eventType), uint32(characters))
	}
}

//export electrobunDecideNavigationHandler
func electrobunDecideNavigationHandler(webviewID C.uint32_t, url *C.char) C.uint32_t {
	id := uint32(webviewID)
	callbackMu.RLock()
	handler := webviewCallbackRegistry[id].DecideNavigation
	callbackMu.RUnlock()
	if handler == nil {
		return 1
	}
	return C.uint32_t(handler(id, C.GoString(url)))
}

//export electrobunWebviewEventHandler
func electrobunWebviewEventHandler(webviewID C.uint32_t, eventName *C.char, detail *C.char) {
	id := uint32(webviewID)
	callbackMu.RLock()
	handler := webviewCallbackRegistry[id].Event
	callbackMu.RUnlock()
	if handler != nil {
		handler(id, C.GoString(eventName), C.GoString(detail))
	}
}

//export electrobunWebviewEventBridgeHandler
func electrobunWebviewEventBridgeHandler(webviewID C.uint32_t, message *C.char) {
	id := uint32(webviewID)
	callbackMu.RLock()
	handler := webviewCallbackRegistry[id].EventBridge
	callbackMu.RUnlock()
	if handler != nil {
		handler(id, C.GoString(message))
	}
}

//export electrobunWebviewHostBridgeHandler
func electrobunWebviewHostBridgeHandler(webviewID C.uint32_t, message *C.char) {
	id := uint32(webviewID)
	callbackMu.RLock()
	handler := webviewCallbackRegistry[id].HostBridge
	callbackMu.RUnlock()
	if handler != nil {
		handler(id, C.GoString(message))
	}
}

//export electrobunWebviewInternalBridgeHandler
func electrobunWebviewInternalBridgeHandler(webviewID C.uint32_t, message *C.char) {
	id := uint32(webviewID)
	callbackMu.RLock()
	handler := webviewCallbackRegistry[id].InternalBridge
	callbackMu.RUnlock()
	if handler != nil {
		handler(id, C.GoString(message))
	}
}

//export electrobunStatusItemHandler
func electrobunStatusItemHandler(itemID C.uint32_t, message *C.char) {
	callbackMu.RLock()
	handler := statusItemHandler
	callbackMu.RUnlock()
	if handler != nil {
		handler(uint32(itemID), C.GoString(message))
	}
}

//export electrobunGlobalShortcutHandler
func electrobunGlobalShortcutHandler(accelerator *C.char) {
	callbackMu.RLock()
	handler := globalShortcutHandler
	callbackMu.RUnlock()
	if handler != nil {
		handler(C.GoString(accelerator))
	}
}

//export electrobunURLOpenHandler
func electrobunURLOpenHandler(url *C.char) {
	callbackMu.RLock()
	handler := urlOpenHandler
	callbackMu.RUnlock()
	if handler != nil {
		handler(C.GoString(url))
	}
}

//export electrobunAppReopenHandler
func electrobunAppReopenHandler() {
	callbackMu.RLock()
	handler := appReopenHandler
	callbackMu.RUnlock()
	if handler != nil {
		handler()
	}
}

//export electrobunQuitRequestedHandler
func electrobunQuitRequestedHandler() {
	callbackMu.RLock()
	handler := quitRequestedHandler
	callbackMu.RUnlock()
	if handler != nil {
		handler()
	}
}
