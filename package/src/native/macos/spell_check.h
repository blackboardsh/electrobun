#pragma once

#import <Foundation/Foundation.h>
#import <objc/message.h>

namespace electrobun {

inline SEL continuousSpellCheckingSelector()
{
    return NSSelectorFromString(@"_setContinuousSpellCheckingEnabledForTesting:");
}

inline bool supportsContinuousSpellChecking(id target)
{
    return target && [target respondsToSelector:continuousSpellCheckingSelector()];
}

inline bool setContinuousSpellChecking(id target, bool enabled)
{
    SEL selector = continuousSpellCheckingSelector();
    if (!target || ![target respondsToSelector:selector])
        return false;

    // WKWebView has no public macOS spell-checking API. This WebKit testing SPI
    // currently updates process-level TextChecker state and the target page
    // process. Keep it isolated and guarded so WebKit changes are detectable.
    reinterpret_cast<void (*)(id, SEL, BOOL)>(objc_msgSend)(
        target,
        selector,
        enabled ? YES : NO);
    return true;
}

} // namespace electrobun
