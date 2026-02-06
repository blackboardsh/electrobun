// Electrobun Sandboxed Preload Script (for untrusted webviews)
// This is compiled to JS and injected into webviews that ARE sandboxed
//
// Minimal functionality for security: NO RPC, NO encryption, NO webview tags
// Only includes: lifecycle events, cmd+click handling, overscroll prevention
//
// Before this script runs, the following must be set:
// - window.__electrobunWebviewId
// - window.__electrobunWindowId
// - window.__electrobunEventBridge (event emission only)

import "./globals.d.ts";
import {
	initLifecycleEvents,
	initCmdClickHandling,
	initSPANavigationInterception,
	initOverscrollPrevention,
} from "./events";

// Initialize minimal features for sandboxed webviews
// No RPC handlers - sandboxed webviews cannot communicate with Bun
// No drag regions - sandboxed content shouldn't control window movement
// No webview tags - sandboxed content cannot create OOPIFs

initLifecycleEvents();
initCmdClickHandling();
initSPANavigationInterception();
initOverscrollPrevention();
