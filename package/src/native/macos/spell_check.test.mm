#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <cstdio>

#include "spell_check.h"

static int failures = 0;

#define CHECK(condition, message) \
    do { \
        if (!(condition)) { \
            std::fprintf(stderr, "FAIL: %s\n", message); \
            ++failures; \
        } \
    } while (false)

@interface SpellCheckTarget : NSObject
@property (nonatomic, assign) BOOL lastValue;
@property (nonatomic, assign) NSUInteger callCount;
@end

@implementation SpellCheckTarget
- (void)_setContinuousSpellCheckingEnabledForTesting:(BOOL)enabled
{
    self.lastValue = enabled;
    self.callCount += 1;
}
@end

@interface SpellCheckNavigationProbe : NSObject <WKNavigationDelegate>
@property (nonatomic, assign) BOOL desiredEnabled;
@property (nonatomic, assign) BOOL selectorSupported;
@property (nonatomic, assign) NSUInteger navigationCount;
@end

@implementation SpellCheckNavigationProbe
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation
{
    (void)navigation;
    BOOL supported = electrobun::setContinuousSpellChecking(webView, self.desiredEnabled);
    self.selectorSupported = self.navigationCount == 0 ? supported : self.selectorSupported && supported;
    self.navigationCount += 1;
}
@end

static bool waitForNavigationCount(SpellCheckNavigationProbe *probe, NSUInteger expectedCount)
{
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10.0];
    while (probe.navigationCount < expectedCount && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return probe.navigationCount >= expectedCount;
}

static void testGuardedSelectorDispatch()
{
    CHECK(!electrobun::supportsContinuousSpellChecking(nil), "nil must not report support");
    CHECK(!electrobun::setContinuousSpellChecking(nil, true), "nil must reject spell checking");

    NSObject *unsupported = [[NSObject alloc] init];
    CHECK(!electrobun::supportsContinuousSpellChecking(unsupported), "unsupported object must not report support");
    CHECK(!electrobun::setContinuousSpellChecking(unsupported, true), "unsupported object must reject spell checking");

    SpellCheckTarget *target = [[SpellCheckTarget alloc] init];
    CHECK(electrobun::supportsContinuousSpellChecking(target), "supported object must report support");
    CHECK(electrobun::setContinuousSpellChecking(target, true), "enable dispatch must succeed");
    CHECK(target.lastValue == YES && target.callCount == 1, "enable value must reach selector");
    CHECK(electrobun::setContinuousSpellChecking(target, false), "disable dispatch must succeed");
    CHECK(target.lastValue == NO && target.callCount == 2, "disable value must reach selector");
}

static void testRealWKWebViewAfterNavigation()
{
    [NSApplication sharedApplication];

    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    WKWebView *webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 480, 320)
                                            configuration:configuration];
    SpellCheckNavigationProbe *probe = [[SpellCheckNavigationProbe alloc] init];
    probe.desiredEnabled = YES;
    webView.navigationDelegate = probe;
    [webView loadHTMLString:@"<!doctype html><div contenteditable autofocus>mispellled wurd</div>"
                    baseURL:nil];

    CHECK(waitForNavigationCount(probe, 1), "real WKWebView navigation must finish");
    CHECK(probe.selectorSupported, "installed WKWebView must expose the guarded spell-check SPI");

    if (probe.selectorSupported) {
        probe.desiredEnabled = NO;
        [webView loadHTMLString:@"<!doctype html><div contenteditable>second navigashun</div>"
                        baseURL:nil];
        CHECK(waitForNavigationCount(probe, 2), "real WKWebView second navigation must finish");
        CHECK(probe.selectorSupported, "spell-check SPI must remain available after navigation");
        std::printf("PASS: real WKWebView accepted spell-check SPI after each didFinishNavigation\n");
    }

    webView.navigationDelegate = nil;
    [webView stopLoading];
}

int main()
{
    @autoreleasepool {
        testGuardedSelectorDispatch();
        testRealWKWebViewAfterNavigation();
    }

    if (failures == 0) {
        std::printf("PASS: macOS spell-check native tests\n");
        return 0;
    }
    return 1;
}
