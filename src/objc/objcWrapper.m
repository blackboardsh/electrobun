#import <WebKit/WebKit.h>

// generic utils

// manually retain and release objects so they don't get deallocated
// Function to retain any Objective-C object
void retainObjCObject(id objcObject) {
    CFRetain((__bridge CFTypeRef)objcObject);
}

// Function to release any Objective-C object
void releaseObjCObject(id objcObject) {
    CFRelease((__bridge CFTypeRef)objcObject);
}

// mask utils
typedef struct {
    BOOL Borderless;
    BOOL Titled;
    BOOL Closable;
    BOOL Miniaturizable;
    BOOL Resizable;
    BOOL UnifiedTitleAndToolbar;
    BOOL FullScreen;
    BOOL FullSizeContentView;
    BOOL UtilityWindow;
    BOOL DocModalWindow;
    BOOL NonactivatingPanel;
    BOOL HUDWindow;
} WindowStyleMaskOptions;

NSUInteger getNSWindowStyleMask(WindowStyleMaskOptions options) {
     NSLog(@"Passed style getwindowstylemaks<><><><>");
    NSUInteger mask = 0; 
    if (options.Borderless) {
        NSLog(@"Passed style BORDERLESS<><><><>");
        mask |= NSWindowStyleMaskBorderless;
    }
    if (options.Titled)     {
        NSLog(@"Passed style TITLED<><><>");
        mask |= NSWindowStyleMaskTitled;
    }
    if (options.Closable) {
        mask |= NSWindowStyleMaskClosable;
    }
    if (options.Miniaturizable) {
        mask |= NSWindowStyleMaskMiniaturizable;
    }
    if (options.Resizable) {
        mask |= NSWindowStyleMaskResizable;
    }
    if (options.UnifiedTitleAndToolbar) {
        mask |= NSWindowStyleMaskUnifiedTitleAndToolbar;
    }
    if (options.FullScreen) {
        mask |= NSWindowStyleMaskFullScreen;
    }
    if (options.FullSizeContentView) {
        mask |= NSWindowStyleMaskFullSizeContentView;
    }
    if (options.UtilityWindow) {
        mask |= NSWindowStyleMaskUtilityWindow;
    }
    if (options.DocModalWindow) {
        mask |= NSWindowStyleMaskDocModalWindow;
    }
    if (options.NonactivatingPanel) {
        mask |= NSWindowStyleMaskNonactivatingPanel;
    }
    if (options.HUDWindow) {
        mask |= NSWindowStyleMaskHUDWindow;
    }

    return mask;
}

// application
void runNSApplication() {
    [[NSApplication sharedApplication] run];    
}


// WKWebView
WKWebView* createAndReturnWKWebView(NSRect frame) {
    // Create a default WKWebViewConfiguration
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    
    // Define a default frame; you might want to parameterize this
    // CGRect frame = CGRectMake(0, 0, 1800, 600); // Example frame

    // Allocate and initialize the WKWebView
    WKWebView *webView = [[WKWebView alloc] initWithFrame:frame configuration:configuration];

    retainObjCObject(webView);
    // Perform any additional setup here
    return webView;
}

void loadURLInWebView(WKWebView *webView, const char *urlString) {
    NSString *urlNSString = [NSString stringWithUTF8String:urlString];
    NSURL *url = [NSURL URLWithString:urlNSString];
    NSURLRequest *request = [NSURLRequest requestWithURL:url];
    [webView loadRequest:request];
}

void loadHTMLInWebView(WKWebView *webView, const char *htmlString) {
    NSString *htmlNSString = [NSString stringWithUTF8String:htmlString];
    NSURL *baseURL = [NSURL URLWithString:@"file://"];
    [webView loadHTMLString:htmlNSString baseURL:baseURL];
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
    NSLog(@"?????????????????? inside evaluateJavaScriptWithNoCompletion objc");
    NSString *javaScript = [NSString stringWithUTF8String:jsString];
    [webView evaluateJavaScript:javaScript completionHandler:nil];
}

void* getNilValue() {
    return NULL;
}

void addPreloadScriptToWebView(WKWebView *webView, const char *scriptContent, BOOL forMainFrameOnly) {
    // Create a WKUserScript object with the provided script content
    // Injection time is set to atDocumentStart to ensure it runs before the page content loads
    WKUserScript *userScript = [[WKUserScript alloc] initWithSource:[NSString stringWithUTF8String:scriptContent]
                                                      injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                   forMainFrameOnly:forMainFrameOnly];

    // Get the userContentController from the WKWebView's configuration
    WKUserContentController *userContentController = webView.configuration.userContentController;

    // Add the user script to the content controller
    [userContentController addUserScript:userScript];
}

// NSWindow

typedef struct {
    NSRect frame;
    WindowStyleMaskOptions styleMask;
} createNSWindowWithFrameAndStyleParams;

NSWindow *createNSWindowWithFrameAndStyle(createNSWindowWithFrameAndStyleParams config) {    
    NSWindow *window = [[NSWindow alloc] initWithContentRect:config.frame
                                                   styleMask:getNSWindowStyleMask(config.styleMask)
                                                     backing:NSBackingStoreBuffered
                                                       defer:YES];    

    return window; 
}

void makeNSWindowKeyAndOrderFront(NSWindow *window) {
    [window makeKeyAndOrderFront:nil];
}

void setNSWindowTitle(NSWindow *window, const char *title) {    
    NSString *titleString = [NSString stringWithUTF8String:title];
    [window setTitle:titleString];
}

// Sets the main content view of the window
void setContentView(NSWindow *window, NSView *view) {
    [window setContentView:view];
}

// todo: add addSubview function

NSRect createNSRectWrapper(double x, double y, double width, double height) {
    NSLog(@"Passed frame = x: %f, y: %f, width: %f, height: %f", x, y, width, height);
    
    return NSMakeRect(x, y, width, height);
}



NSRect getWindowBounds(NSWindow *window) {
    NSView *contentView = [window contentView];
    return [contentView bounds];
}




// navigation delegate that 
typedef BOOL (*DecideNavigationCallback)(uint32_t webviewId, const char* url);

@interface MyNavigationDelegate : NSObject <WKNavigationDelegate>
@property (nonatomic, assign) DecideNavigationCallback zigCallback;
@property (nonatomic, assign) uint32_t webviewId;
@end

@implementation MyNavigationDelegate

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSLog(@"?????????????????? inside navigation delegate objc");
    // decisionHandler(WKNavigationActionPolicyAllow);
    NSURL *url = navigationAction.request.URL;
    BOOL shouldAllow = self.zigCallback(self.webviewId, url.absoluteString.UTF8String);
    decisionHandler(shouldAllow ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

@end

MyNavigationDelegate* setNavigationDelegateWithCallback(WKWebView *webView, uint32_t webviewId, DecideNavigationCallback callback) {        
    MyNavigationDelegate *delegate = [[MyNavigationDelegate alloc] init];
    delegate.zigCallback = callback;
    delegate.webviewId = webviewId;
    webView.navigationDelegate = delegate;        

    // todo: release this delegate when the window is closed from zig
    retainObjCObject(delegate);
    
    return delegate;
}

// add postMessage handler
typedef BOOL (*HandlePostMessageCallback)(uint32_t webviewId, const char* message);

// todo: add webviewId as a property here
@interface MyScriptMessageHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, assign) HandlePostMessageCallback zigCallback;
@property (nonatomic, assign) uint32_t webviewId;
@end

@implementation MyScriptMessageHandler

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
    NSLog(@"?????????????????? inside post message delegate objc");
    NSString *body = message.body;
    // return body.UTF8String;
    
    self.zigCallback(self.webviewId, body.UTF8String);    
}

@end

// todo: this actually isn't withCallback
MyScriptMessageHandler* addScriptMessageHandlerWithCallback(WKWebView *webView, uint32_t webviewId, const char *name, HandlePostMessageCallback callback) {
    MyScriptMessageHandler *handler = [[MyScriptMessageHandler alloc] init];
    handler.zigCallback = callback;    
    handler.webviewId = webviewId;
    [webView.configuration.userContentController addScriptMessageHandler:handler name:[NSString stringWithUTF8String:name]];
    // todo: release this handler when the window is closed from zig
    retainObjCObject(handler);

    return handler;
}

