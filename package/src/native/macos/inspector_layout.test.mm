#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>

#include <cmath>
#include <cstdlib>
#include "inspector_layout.h"

static BOOL rectsEqual(NSRect lhs, NSRect rhs)
{
    return fabs(lhs.origin.x - rhs.origin.x) < 0.5
        && fabs(lhs.origin.y - rhs.origin.y) < 0.5
        && fabs(lhs.size.width - rhs.size.width) < 0.5
        && fabs(lhs.size.height - rhs.size.height) < 0.5;
}

static void fail(NSString *message)
{
    NSLog(@"FAIL: %@", message);
    exit(EXIT_FAILURE);
}

@interface InspectorLayoutTestDelegate : NSObject <NSApplicationDelegate>
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) NSView *container;
@property (nonatomic, strong) WKWebView *webView;
@end

@implementation InspectorLayoutTestDelegate

- (void)waitForInspectorToCloseWithExpectedFrame:(NSRect)expectedFrame attemptsRemaining:(NSUInteger)attempts
{
    if (!electrobunAttachedInspectorView(self.webView)
        && rectsEqual(self.webView.frame, expectedFrame)) {
        NSLog(@"PASS: docked inspector preserves and restores the inspected view layout");
        exit(EXIT_SUCCESS);
    }

    if (!attempts) {
        fail([NSString stringWithFormat:@"inspector did not close cleanly; frame=%@ attached=%@",
            NSStringFromRect(self.webView.frame),
            electrobunAttachedInspectorView(self.webView) ? @"YES" : @"NO"]);
        return;
    }

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        [self waitForInspectorToCloseWithExpectedFrame:expectedFrame attemptsRemaining:attempts - 1];
    });
}

- (void)verifyAttachedInspectorWithExpectedFrame:(NSRect)expectedFrame attemptsRemaining:(NSUInteger)attempts
{
    WKWebView *inspectorView = electrobunAttachedInspectorView(self.webView);
    NSRect attachedFrame = self.webView.frame;
    if (!inspectorView || attachedFrame.size.height >= expectedFrame.size.height) {
        if (!attempts) {
            fail(inspectorView
                    ? @"WebKit did not reserve space for the attached inspector"
                    : @"inspector did not attach to the inspected view's container");
            return;
        }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            [self verifyAttachedInspectorWithExpectedFrame:expectedFrame attemptsRemaining:attempts - 1];
        });
        return;
    }

    // This is the mirror request ContainerView makes when the pointer enters
    // the docked inspector. Applying the old transform here reproduces the
    // zero-height content and stale frame reported in #357.
    if (electrobunShouldEnableMirrorMode(self.webView, YES)) {
        self.webView.frame = NSOffsetRect(self.webView.frame, -20000, -20000);
        self.webView.layer.position = NSMakePoint(0, 0);
    }

    if (!rectsEqual(self.webView.frame, attachedFrame)) {
        fail(@"mirror mode changed WebKit's attached-inspector layout");
        return;
    }

    id inspector = electrobunInspectorForWebView(self.webView);
    SEL closeSelector = NSSelectorFromString(@"close");
    ((void (*)(id, SEL))objc_msgSend)(inspector, closeSelector);
    [self waitForInspectorToCloseWithExpectedFrame:expectedFrame attemptsRemaining:100];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
    (void)notification;

    NSRect expectedFrame = NSMakeRect(0, 0, 900, 700);
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 900, 700)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
            | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
        backing:NSBackingStoreBuffered defer:NO];
    self.window.titlebarAppearsTransparent = YES;
    self.window.titleVisibility = NSWindowTitleHidden;
    self.container = [[NSView alloc] initWithFrame:expectedFrame];
    self.window.contentView = self.container;

    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    [configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
    self.webView = [[WKWebView alloc] initWithFrame:expectedFrame configuration:configuration];
    self.webView.wantsLayer = YES;
    [self.container addSubview:self.webView];
    [self.webView loadHTMLString:@"<h1>Inspector layout regression</h1>" baseURL:nil];
    [self.window makeKeyAndOrderFront:nil];

    if (electrobunAttachedInspectorView(self.webView)) {
        fail(@"inspector unexpectedly attached before opening");
        return;
    }

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        id inspector = electrobunInspectorForWebView(self.webView);
        SEL showSelector = NSSelectorFromString(@"show");
        SEL attachSelector = NSSelectorFromString(@"attach");
        if (![inspector respondsToSelector:showSelector] || ![inspector respondsToSelector:attachSelector]) {
            fail(@"system WebKit inspector API is unavailable");
            return;
        }

        ((void (*)(id, SEL))objc_msgSend)(inspector, showSelector);
        ((void (*)(id, SEL))objc_msgSend)(inspector, attachSelector);
        [self verifyAttachedInspectorWithExpectedFrame:expectedFrame attemptsRemaining:100];
    });
}

@end


int main(void)
{
    @autoreleasepool {
        NSApplication *application = [NSApplication sharedApplication];
        InspectorLayoutTestDelegate *delegate = [[InspectorLayoutTestDelegate alloc] init];
        application.delegate = delegate;
        [application run];
    }
    return EXIT_FAILURE;
}
