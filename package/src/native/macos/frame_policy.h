#pragma once

#import <WebKit/WebKit.h>

namespace electrobun {

// A webview's navigation rules protect its main document. Embedded documents
// retain their own browser origin/sandbox restrictions and parent transport.
// A missing target is a new-window request, not permission to bypass rules.
inline bool shouldApplyMainFrameNavigationRules(WKNavigationAction *action)
{
    return !action.targetFrame || action.targetFrame.isMainFrame;
}

// WKUserContentController exposes registered handlers in child frames even
// when the associated preload is injected into the main frame only.
inline bool isMainFrameScriptMessage(WKScriptMessage *message)
{
    return message.frameInfo && message.frameInfo.isMainFrame;
}

} // namespace electrobun
