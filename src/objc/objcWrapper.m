#import <WebKit/WebKit.h>


// views:// schema handler

typedef struct {
    const char *mimeType;
    const char *fileContents;  
    size_t len;  
} FileResponse;

// Define callback types for starting and stopping URL scheme tasks
typedef FileResponse (*zigStartURLSchemeTaskCallback)(uint32_t webviewId, const char* url, const char* body);

@interface MyURLSchemeHandler : NSObject <WKURLSchemeHandler>
@property (nonatomic, assign) zigStartURLSchemeTaskCallback fileLoader;
@property (nonatomic, assign) uint32_t webviewId;
@end

@implementation MyURLSchemeHandler

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
    NSURL *url = urlSchemeTask.request.URL;    
    NSData *bodyData = urlSchemeTask.request.HTTPBody;
    NSString *bodyString = [[NSString alloc] initWithData:bodyData encoding:NSUTF8StringEncoding];
        
    // todo: the zig handler should return the file to here, and objc can send it back to the webview
    if (self.fileLoader) {                
        FileResponse fileResponse = self.fileLoader(self.webviewId, url.absoluteString.UTF8String, bodyString.UTF8String);                        

        NSData *data = [NSData dataWithBytes:fileResponse.fileContents length:fileResponse.len];        
        // Determine MIME type from the response, or default if null
        NSString *mimeType = fileResponse.mimeType ? [NSString stringWithUTF8String:fileResponse.mimeType] : @"application/octet-stream";
        
        // Create a response - you might need to adjust the MIME type
        NSURLResponse *response = [[NSURLResponse alloc] initWithURL:url
        // Webkit will try guess the mimetype based on the file extension. supports common file types  https://github.com/WebKit/WebKit/blob/a78127adb38a402b5d0fe6b17367aba32a38eb22/Source/WebCore/platform/playstation/MIMETypeRegistryPlayStation.cpp#L34-L55
        // If/when we need to support more file types, we can implement that in zig cross-platform and allow extending with more
        // bun also has comprehensive mimetype detection written in zig that could be used but increases the binary size
                                                            MIMEType:mimeType 
                                               expectedContentLength:data.length
                                                    textEncodingName:nil];
        
        // Inform the urlSchemeTask of the response
        [urlSchemeTask didReceiveResponse:response];
        
        // Send the data
        [urlSchemeTask didReceiveData:data];
        
        // Complete the task
        [urlSchemeTask didFinish];
        // how to send the fileContents back to the webview?
    }
}

- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
    NSURL *url = urlSchemeTask.request.URL;
    NSLog(@"Stopping URL scheme task for URL: %@", url);    
}

@end

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
    NSUInteger mask = 0; 
    if (options.Borderless) {        
        mask |= NSWindowStyleMaskBorderless;
    }
    if (options.Titled)     {        
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
WKWebView* createAndReturnWKWebView(uint32_t webviewId, NSRect frame, zigStartURLSchemeTaskCallback assetFileLoader, bool autoResize) {
    // Create a default WKWebViewConfiguration
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];    

    // wire up views:// schema handler
    MyURLSchemeHandler *assetSchemeHandler = [[MyURLSchemeHandler alloc] init];
    assetSchemeHandler.fileLoader = assetFileLoader;    
    assetSchemeHandler.webviewId = webviewId;

    // Note: Keep "views" in sync with views:// in webview.zig
    [configuration setURLSchemeHandler:assetSchemeHandler forURLScheme:@"views"];
    retainObjCObject(assetSchemeHandler);

    // open devtools
    // Enable Developer Extras (right click to inspect element)
    [configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];


    // Allocate and initialize the WKWebView
    WKWebView *webView = [[WKWebView alloc] initWithFrame:frame configuration:configuration];
    
    // Since all wkwebviews are children of a generic NSView we need to tell them to 
    // auto size with the window. 
    if (autoResize) {
        webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    }

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

void webviewTagGoBack(WKWebView *webView) {
    [webView goBack];
}
void webviewTagGoForward(WKWebView *webView) {
    [webView goForward];
}
void webviewTagReload(WKWebView *webView) {
    [webView reload];
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

void evaluateJavaScriptWithNoCompletion(WKWebView *webView, const char *jsString) {    
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

    // Add the user script to the content controller
    [webView.configuration.userContentController addUserScript:userScript];
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

    // Give it a default content view that can accept subviews later on                                                                                                               
    NSView *contentView = [[NSView alloc] initWithFrame:[window frame]];
    [window setContentView:contentView];

    return window; 
}

void makeNSWindowKeyAndOrderFront(NSWindow *window) {
    [window makeKeyAndOrderFront:nil];        
}

void setNSWindowTitle(NSWindow *window, const char *title) {    
    NSString *titleString = [NSString stringWithUTF8String:title];
    [window setTitle:titleString];
}

void addWebviewToWindow(NSWindow *window, NSView *view) {

    [window.contentView addSubview:view positioned:NSWindowAbove relativeTo:nil];        

    CGFloat adjustedY = view.superview.bounds.size.height - view.frame.origin.y - view.frame.size.height;
    view.frame = NSMakeRect(view.frame.origin.x, adjustedY, view.frame.size.width, view.frame.size.height);
}

void resizeWebview(NSView *view, NSRect frame) {
    CGFloat adjustedY = view.superview.bounds.size.height - frame.origin.y - frame.size.height;
    view.frame = NSMakeRect(frame.origin.x, adjustedY, frame.size.width, frame.size.height);
}

NSRect createNSRectWrapper(double x, double y, double width, double height) {    
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
typedef BOOL (*HandlePostMessage)(uint32_t webviewId, const char* message);

// todo: add webviewId as a property here
@interface MyScriptMessageHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, assign) HandlePostMessage zigCallback;
@property (nonatomic, assign) uint32_t webviewId;
@end

@implementation MyScriptMessageHandler

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {    
    NSString *body = message.body;    
    
    self.zigCallback(self.webviewId, body.UTF8String);    
}

@end

MyScriptMessageHandler* addScriptMessageHandler(WKWebView *webView, uint32_t webviewId, const char *name, HandlePostMessage callback) {
    MyScriptMessageHandler *handler = [[MyScriptMessageHandler alloc] init];
    handler.zigCallback = callback;    
    handler.webviewId = webviewId;
    [webView.configuration.userContentController addScriptMessageHandler:handler name:[NSString stringWithUTF8String:name]];
    // todo: release this handler when the window is closed from zig
    retainObjCObject(handler);

    return handler;
}


// add postMessage handler with reply
typedef const char* (*HandlePostMessageWithReply)(uint32_t webviewId, const char* message);

@interface MyScriptMessageHandlerWithReply : NSObject <WKScriptMessageHandlerWithReply>

@property (nonatomic, assign) HandlePostMessageWithReply zigCallback;
@property (nonatomic, assign) uint32_t webviewId;

@end

@implementation MyScriptMessageHandlerWithReply

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message replyHandler:(void (^)(id _Nullable, NSString * _Nullable))replyHandler {
    NSString *body = message.body;
    
    // Call the zig callback and pass the completion handler to send replies
    const char *response = self.zigCallback(self.webviewId, body.UTF8String);

    NSString *responseNSString = [NSString stringWithUTF8String:response];    
            
    replyHandler(responseNSString, nil);
}

@end

MyScriptMessageHandlerWithReply* addScriptMessageHandlerWithReply(WKWebView *webView, uint32_t webviewId, const char *name, HandlePostMessageWithReply callback) {
    MyScriptMessageHandlerWithReply *handler = [[MyScriptMessageHandlerWithReply alloc] init];
    handler.zigCallback = callback;
    handler.webviewId = webviewId;
    
    // Use the new API to add the script message handler
    [webView.configuration.userContentController addScriptMessageHandlerWithReply:handler contentWorld:WKContentWorld.pageWorld name:[NSString stringWithUTF8String:name]];
    
    // Retain the handler if necessary; handle lifecycle management appropriately
    retainObjCObject(handler);

    return handler;
}



// example calling function after a delay for debugging
// dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
//     // Remove the WebView after 10 seconds
//     [view removeFromSuperview];
//     NSLog(@"WebView removed after 10 seconds");
// });


// FS

#import <Foundation/Foundation.h>

BOOL moveToTrash(char *pathString) {        
    NSString *path = [NSString stringWithUTF8String:pathString];
    NSURL *fileURL = [NSURL fileURLWithPath:path];
    NSError *error = nil;
    NSURL *resultingURL = nil;
    
    NSFileManager *fileManager = [NSFileManager defaultManager];
    BOOL success = [fileManager trashItemAtURL:fileURL resultingItemURL:&resultingURL error:&error];
    
    if (success) {
        NSLog(@"Moved to Trash: %@", resultingURL);
    } else {
        NSLog(@"Error: %@", error);
    }

    return success;
}