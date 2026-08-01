#pragma once

#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>

static inline id electrobunInspectorForWebView(WKWebView *webView)
{
    SEL inspectorSelector = NSSelectorFromString(@"_inspector");
    if (!webView || ![webView respondsToSelector:inspectorSelector])
        return nil;

    return ((id (*)(id, SEL))objc_msgSend)(webView, inspectorSelector);
}

static inline WKWebView *electrobunAttachedInspectorView(WKWebView *webView)
{
    if (!webView || !webView.superview)
        return nil;

    Class inspectorViewClass = NSClassFromString(@"WKInspectorWKWebView");
    WKWebView *attachedCandidate = nil;
    for (NSView *sibling in webView.superview.subviews) {
        if (inspectorViewClass && [sibling isKindOfClass:inspectorViewClass]) {
            attachedCandidate = (WKWebView *)sibling;
            break;
        }
    }
    if (!attachedCandidate)
        return nil;

    id inspector = electrobunInspectorForWebView(webView);
    if (!inspector)
        return nil;

    SEL inspectorWebViewSelector = NSSelectorFromString(@"inspectorWebView");
    if ([inspector respondsToSelector:inspectorWebViewSelector]) {
        WKWebView *inspectorWebView =
            ((WKWebView *(*)(id, SEL))objc_msgSend)(inspector, inspectorWebViewSelector);
        if ([inspectorWebView isKindOfClass:inspectorViewClass]
            && inspectorWebView.superview == webView.superview)
            return inspectorWebView;
        return nil;
    }

    // Older WebKit builds do not expose inspectorWebView. An attached inspector
    // is still identifiable by its private view class and shared parent.
    SEL visibleSelector = NSSelectorFromString(@"isVisible");
    if ([inspector respondsToSelector:visibleSelector]
        && !((BOOL (*)(id, SEL))objc_msgSend)(inspector, visibleSelector))
        return nil;

    return attachedCandidate;
}

static inline BOOL electrobunShouldEnableMirrorMode(WKWebView *webView, BOOL requested)
{
    return requested && !electrobunAttachedInspectorView(webView);
}
