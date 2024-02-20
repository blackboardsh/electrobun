#import <WebKit/WebKit.h>

// typedef struct {
//     BOOL Borderless;
//     BOOL Titled;
//     BOOL Closable;
//     BOOL Miniaturizable;
//     BOOL Resizable;
//     BOOL UnifiedTitleAndToolbar;
//     BOOL FullScreen;
//     BOOL FullSizeContentView;
//     BOOL UtilityWindow;
//     BOOL DocModalWindow;
//     BOOL NonactivatingPanel;
//     BOOL HUDWindow;
// } WindowStyleOptions;

// NSUInteger getNSWindowStyleMask(WindowStyleOptions options) {
//      NSLog(@"Passed style getwindowstylemaks<><><><>");
//     NSUInteger mask = 0; 
//     if (options.Borderless) {
//         NSLog(@"Passed style BORDERLESS<><><><>");
//         mask |= NSWindowStyleMaskBorderless;
//     }
//     if (options.Titled)     {
//         NSLog(@"Passed style TITLED<><><>");
//         mask |= NSWindowStyleMaskTitled;
//     }
//     if (options.Closable) {
//         mask |= NSWindowStyleMaskClosable;
//     }
//     if (options.Miniaturizable) {
//         mask |= NSWindowStyleMaskMiniaturizable;
//     }
//     if (options.Resizable) {
//         mask |= NSWindowStyleMaskResizable;
//     }
//     if (options.UnifiedTitleAndToolbar) {
//         mask |= NSWindowStyleMaskUnifiedTitleAndToolbar;
//     }
//     if (options.FullScreen) {
//         mask |= NSWindowStyleMaskFullScreen;
//     }
//     if (options.FullSizeContentView) {
//         mask |= NSWindowStyleMaskFullSizeContentView;
//     }
//     if (options.UtilityWindow) {
//         mask |= NSWindowStyleMaskUtilityWindow;
//     }
//     if (options.DocModalWindow) {
//         mask |= NSWindowStyleMaskDocModalWindow;
//     }
//     if (options.NonactivatingPanel) {
//         mask |= NSWindowStyleMaskNonactivatingPanel;
//     }
//     if (options.HUDWindow) {
//         mask |= NSWindowStyleMaskHUDWindow;
//     }

//     return mask;
// }




// WKWebView
WKWebView* createAndReturnWKWebView(NSRect frame) {
    // Create a default WKWebViewConfiguration
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    
    // Define a default frame; you might want to parameterize this
    // CGRect frame = CGRectMake(0, 0, 1800, 600); // Example frame

    // Allocate and initialize the WKWebView
    WKWebView *webView = [[WKWebView alloc] initWithFrame:frame configuration:configuration];

    // Perform any additional setup here

    return webView;
}

void loadURLInWebView(WKWebView *webView, const char *urlString) {
    NSString *urlNSString = [NSString stringWithUTF8String:urlString];
    NSURL *url = [NSURL URLWithString:urlNSString];
    NSURLRequest *request = [NSURLRequest requestWithURL:url];
    [webView loadRequest:request];
}



void invokeDecisionHandler(void (^decisionHandler)(WKNavigationActionPolicy), WKNavigationActionPolicy policy) {    
    if (decisionHandler != NULL) {
        decisionHandler(policy);
    }
}

const char* getUrlFromNavigationAction(WKNavigationAction *navigationAction) {
    NSURLRequest *request = navigationAction.request;
    NSURL *url = request.URL;
    return url.absoluteString.UTF8String;
}

const char* getBodyFromScriptMessage(WKScriptMessage *message) {
    NSString *body = message.body;
    return body.UTF8String;
}

// Add this to your existing .m file
void evaluateJavaScriptWithNoCompletion(WKWebView *webView, const char *jsString) {
    NSString *javaScript = [NSString stringWithUTF8String:jsString];
    [webView evaluateJavaScript:javaScript completionHandler:nil];
}

void* getNilValue() {
    return NULL;
}

void addPreloadScriptToWebView(WKWebView *webView, NSString *scriptContent, BOOL forMainFrameOnly) {
    // Create a WKUserScript object with the provided script content
    // Injection time is set to atDocumentStart to ensure it runs before the page content loads
    WKUserScript *userScript = [[WKUserScript alloc] initWithSource:scriptContent
                                                      injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                   forMainFrameOnly:forMainFrameOnly];

    // Get the userContentController from the WKWebView's configuration
    WKUserContentController *userContentController = webView.configuration.userContentController;

    // Add the user script to the content controller
    [userContentController addUserScript:userScript];
}

// NSWindow

NSWindow *createNSWindowWithFrameAndStyle(NSRect frame, NSUInteger styleMask) {
    // Allocate the NSWindow object
    NSRect fframe = NSMakeRect(0, 0, 800, 600); // Window size

        NSLog(@"Passed frame = x: %f, y: %f, width: %f, height: %f", frame.origin.x, frame.origin.y, frame.size.width, frame.size.height);
        NSLog(@"Hardcoded fframe = x: %f, y: %f, width: %f, height: %f", fframe.origin.x, fframe.origin.y, fframe.size.width, fframe.size.height);


    NSWindow *window = [[NSWindow alloc] initWithContentRect:frame
                                                   styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
                                                     backing:NSBackingStoreBuffered
                                                       defer:YES];
    // Additional configuration (if needed) can be done here

    return window; // Return the pointer to the initialized window
}

void makeNSWindowKeyAndOrderFront(NSWindow *window) {
    [window makeKeyAndOrderFront:nil];
}

void setNSWindowTitle(NSWindow *window, const char *title) {    
    NSString *titleString = [NSString stringWithUTF8String:title];
    [window setTitle:titleString];
}

void setContentView(NSWindow *window, NSView *view) {
    [window setContentView:view];
}

NSRect createNSRectWrapper(double x, double y, double width, double height) {
    NSLog(@"Passed frame = x: %f, y: %f, width: %f, height: %f", x, y, width, height);
    
    return NSMakeRect(x, y, width, height);
}



NSRect getWindowBounds(NSWindow *window) {
    NSView *contentView = [window contentView];
    return [contentView bounds];
}



