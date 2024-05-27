#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <Foundation/Foundation.h>


// views:// schema handler

typedef struct {
    const char *mimeType;
    const char *fileContents;  
    size_t len;  
} FileResponse;

// Define callback types for starting and stopping URL scheme tasks
typedef FileResponse (*zigStartURLSchemeTaskCallback)(uint32_t webviewId, const char* url, const char* body);

@interface MyURLSchemeHandler : NSObject <WKURLSchemeHandler>
// todo: rename fileLoader to zigContentLoader or zigResponseLoader
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
// Note: retainObj / releaseObj increments and decrements the retain count of the object
// prefer using objc_setAssociatedObject to store objects in other objects
// this lets arc count that association as a reference and auto-cleanup when it's no longer needed
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

@interface AppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation AppDelegate

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    NSLog(@"Intercepting application termination");
    // todo: implement a way to cancel sudden termination from bun
    // in order to allow for cleanup 
    // return NSTerminateCancel;
    return NSTerminateNow;
}

@end


void runNSApplication() {    
    
        NSApplication *app = [NSApplication sharedApplication];    
        AppDelegate *delegate = [[AppDelegate alloc] init];
        [app setDelegate:delegate];

        retainObjCObject(delegate);

        [app run];    
    
    NSLog(@"after run!!!");
    
}


// WKWebView
// custom WKWebView that allows mouse events to pass through
@interface TransparentWKWebView : WKWebView

@property (nonatomic, assign) BOOL isMousePassthroughEnabled;

@end
@implementation TransparentWKWebView

- (NSView *)hitTest:(NSPoint)point {
    if (self.isMousePassthroughEnabled) {
        return nil; // Pass through all mouse events
    }
    return [super hitTest:point];
}

@end


WKWebView* createAndReturnWKWebView(uint32_t webviewId, NSRect frame, zigStartURLSchemeTaskCallback assetFileLoader, zigStartURLSchemeTaskCallback httpsLoader, bool autoResize) {
    // Create a default WKWebViewConfiguration
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];    

    // wire up views:// schema handler
    MyURLSchemeHandler *assetSchemeHandler = [[MyURLSchemeHandler alloc] init];
    assetSchemeHandler.fileLoader = assetFileLoader;    
    assetSchemeHandler.webviewId = webviewId;

    // Note: Keep "views" in sync with views:// in webview.zig
    [configuration setURLSchemeHandler:assetSchemeHandler forURLScheme:@"views"];    
    objc_setAssociatedObject(configuration, "assetSchemeHandler", assetSchemeHandler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);    

    // todo: remove - we're not using this anymore
    MyURLSchemeHandler *httpsSchemeHandler = [[MyURLSchemeHandler alloc] init];
    httpsSchemeHandler.fileLoader = httpsLoader;    
    httpsSchemeHandler.webviewId = webviewId;

    [configuration setURLSchemeHandler:httpsSchemeHandler forURLScheme:@"remote"];
    objc_setAssociatedObject(configuration, "httpsSchemeHandler", httpsSchemeHandler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    
    // open devtools
    // Enable Developer Extras (right click to inspect element)
    [configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];

    // Allocate and initialize the WKWebView
    TransparentWKWebView *webView = [[TransparentWKWebView alloc] initWithFrame:frame configuration:configuration];

    // Note: This makes webview have a transparent background by default.
    // todo: consider making this configurable during webview creation and/or
    // adding a toggle function for it.
    [webView setValue:@NO forKey:@"drawsBackground"];
    webView.layer.backgroundColor = [[NSColor clearColor] CGColor];
    webView.layer.opaque = NO;    
    
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

void webviewRemove(WKWebView *webView) {
    [webView removeFromSuperview];

    // todo: supposedly good practice but not necessary for now
    // webView.navigationDelegate = nil;
    // webView.UIDelegate = nil;    

    releaseObjCObject(webView);
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


// This adds a commend with a unique script identifier to the user script, and removes any existing ones with that identifier
// This is useful for cases where you want to change an existing user script during the lifetime of a webview
void updatePreloadScriptToWebView(WKWebView *webView, const char *scriptIdentifier, const char *scriptContent, BOOL forMainFrameOnly) {
    WKUserContentController *contentController = webView.configuration.userContentController;
    
    // Prepare the script identifier as a comment
    NSString *identifierComment = [NSString stringWithFormat:@"// %@\n", [NSString stringWithUTF8String:scriptIdentifier]];
    NSString *newScriptSource = [identifierComment stringByAppendingString:[NSString stringWithUTF8String:scriptContent]];
    
    // Store existing scripts except the one to be updated
    NSMutableArray *newScripts = [NSMutableArray array];
    for (WKUserScript *userScript in contentController.userScripts) {
        if (![userScript.source containsString:identifierComment]) {
            [newScripts addObject:userScript];
        }
    }

    // Clear all scripts
    [contentController removeAllUserScripts];
    
    // Add back the non-updated scripts
    for (WKUserScript *userScript in newScripts) {
        [contentController addUserScript:userScript];
    }

    // Add the new user script
    WKUserScript *newUserScript = [[WKUserScript alloc] initWithSource:newScriptSource
                                                          injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                       forMainFrameOnly:forMainFrameOnly];
    [contentController addUserScript:newUserScript];
}

BOOL webviewCanGoBack(WKWebView *webView) {
    return [webView canGoBack];
}

BOOL webviewCanGoForward(WKWebView *webView) {
    return [webView canGoForward];
}

// NSWindow
@interface WindowDelegate : NSObject <NSWindowDelegate>
@end

@implementation WindowDelegate
- (BOOL)windowShouldClose:(NSWindow *)sender {    
    // todo: Implement a way to prevent a window closing

   return YES;
}
- (void)windowWillClose:(NSNotification *)notification {
    // todo: Perform any cleanup needed    
    NSWindow *window = [notification object];
    // [window setContentView:nil]; // Release content view if needed    
}
@end


typedef struct {
    NSRect frame;
    WindowStyleMaskOptions styleMask;
    const char *titleBarStyle;
} createNSWindowWithFrameAndStyleParams;

NSWindow *createNSWindowWithFrameAndStyle(createNSWindowWithFrameAndStyleParams config) {    
    NSWindow *window = [[NSWindow alloc] initWithContentRect:config.frame
                                                   styleMask:getNSWindowStyleMask(config.styleMask)                                                                                                
                                                     backing:NSBackingStoreBuffered
                                                       defer:YES];    

    if (strcmp(config.titleBarStyle, "hiddenInset") == 0) {
        window.titlebarAppearsTransparent = YES;
        window.titleVisibility = NSWindowTitleHidden;
    }    

    WindowDelegate *delegate = [[WindowDelegate alloc] init];
    [window setDelegate:delegate];
    objc_setAssociatedObject(window, "WindowDelegate", delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    // ARC will try to release the window or something which will be one too many
    // or something leading to a panic crash.. or something. Anyway after
    // losing my mind over this behaviour all day setting this to NO fixes it.
    window.releasedWhenClosed = NO; 

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

void closeNSWindow(NSWindow *window) {
    [window close];    
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

typedef void (*zigSnapshotCallback)(uint32_t hostId, uint32_t webviewId, const char * dataUrl);

void getWebviewSnapshot(uint32_t hostId, uint32_t webviewId, WKWebView *webView, zigSnapshotCallback callback){
    // Create a snapshot configuration
    WKSnapshotConfiguration *snapshotConfig = [[WKSnapshotConfiguration alloc] init];
    
    // Capture the snapshot
    [webView takeSnapshotWithConfiguration:snapshotConfig completionHandler:^(NSImage *snapshotImage, NSError *error) {
        if (error) {           
            NSLog(@"Error capturing snapshot: %@", error);              
            return;
        }
        
        // Convert the image to PNG data         
        NSBitmapImageRep *imgRep = [[NSBitmapImageRep alloc] initWithData:[snapshotImage TIFFRepresentation]];
        NSData *pngData = [imgRep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        
        // Convert PNG data to Base64 string
        NSString *base64String = [pngData base64EncodedStringWithOptions:0];
        
        // Create Data URL
        NSString *dataUrl = [NSString stringWithFormat:@"data:image/png;base64,%@", base64String];
        
        // Return the Data URL
        if (callback) {
            callback(hostId, webviewId, [dataUrl UTF8String]);
        }
    }];
}

// todo: rename these from webviewTagX to webviewX
// This makes the webview invisible.
void webviewTagSetTransparent(WKWebView *webview, BOOL transparent) {
    if (transparent) {       
        webview.layer.opacity = 0; 
    } else {        
        webview.layer.opacity = 1; 
    }
}

void webviewTagSetPassthrough(TransparentWKWebView *webview, BOOL enablePassthrough) {
    if (enablePassthrough) {               
        webview.isMousePassthroughEnabled = YES;        
    } else {        
        webview.isMousePassthroughEnabled = NO;
    }
}

void webviewSetHidden(WKWebView *webview, BOOL hidden) {
    if (hidden) {
        [webview setHidden:YES];
    } else {
        [webview setHidden:NO];
    }    
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
    
    objc_setAssociatedObject(webView, "NavigationDelegate", delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    
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
    
    NSString *key = [NSString stringWithFormat:@"PostMessageHandler{%s}", name];
    objc_setAssociatedObject(webView, key.UTF8String, handler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

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
    
    NSString *key = [NSString stringWithFormat:@"PostMessageHandlerWithReply{%s}", name];
    objc_setAssociatedObject(webView, key.UTF8String, handler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    

    return handler;
}



// example calling function after a delay for debugging
// dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
//     // Remove the WebView after 10 seconds
//     [view removeFromSuperview];
//     NSLog(@"WebView removed after 10 seconds");
// });


// FS



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

// window move


static BOOL isMovingWindow = NO;
static NSWindow *targetWindow = nil;
static CGFloat offsetX = 0.0;
static CGFloat offsetY = 0.0;
static id mouseDraggedMonitor = nil;
static id mouseUpMonitor = nil;

void stopWindowMove() {    
    isMovingWindow = NO;
    targetWindow = nil;
    offsetX = 0.0;
    offsetY = 0.0;

    if (mouseDraggedMonitor) {
        [NSEvent removeMonitor:mouseDraggedMonitor];
        mouseDraggedMonitor = nil;
    }

    if (mouseUpMonitor) {
        [NSEvent removeMonitor:mouseUpMonitor];
        mouseUpMonitor = nil;
    }
}


void startWindowMove(WKWebView *webView) {    
    targetWindow = webView.window;
    if (!targetWindow) {
        NSLog(@"No window found for the given WebView.");
        return;
    }

    isMovingWindow = YES;

    NSPoint initialLocation = [NSEvent mouseLocation];

    mouseDraggedMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseDragged | NSEventMaskMouseMoved) handler:^NSEvent *(NSEvent *event) {
        if (isMovingWindow) {
            NSPoint currentLocation = [NSEvent mouseLocation];

            if (offsetX == 0.0 && offsetY == 0.0) {
                NSPoint windowOrigin = targetWindow.frame.origin;
                offsetX = initialLocation.x - windowOrigin.x;
                offsetY = initialLocation.y - windowOrigin.y;
            }

            CGFloat newX = currentLocation.x - offsetX;
            CGFloat newY = currentLocation.y - offsetY;            

            [targetWindow setFrameOrigin:NSMakePoint(newX, newY)];
        }
        return event;
    }];

    mouseUpMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseUp handler:^NSEvent *(NSEvent *event) {
        if (isMovingWindow) {
            stopWindowMove();
        }
        return event;
    }];
}


// system tray and menues
typedef void (*MenuHandler)(const char *menuItemId);
typedef void (*ZigStatusItemHandler)(uint32_t trayId, const char *action);

@interface StatusItemTarget : NSObject
@property (nonatomic, assign) NSStatusItem *statusItem;
@property (nonatomic, assign) ZigStatusItemHandler zigHandler;
@property (nonatomic, assign) uint32_t trayId;

- (void)statusItemClicked:(id)sender;
- (void)menuItemClicked:(id)sender;

@end

@implementation StatusItemTarget
- (void)statusItemClicked:(id)sender {
    // If there's not menu associated with this status item, then clicking and right clicking on it will
    // trigger this. If there's a menu, then this click is ignored and menu clicks call menuItemClicked instead.
    if (self.zigHandler) {
        self.zigHandler(self.trayId, "");
    }
}
- (void)menuItemClicked:(id)sender {       
    // If there's a menu then only menu     
    NSMenuItem *menuItem = (NSMenuItem *)sender;
    NSString *action = menuItem.representedObject;

    if (self.zigHandler) {
        self.zigHandler(self.trayId, [action UTF8String]);
    }
}
@end

NSStatusItem* createTray(uint32_t trayId, const char *pathToImage, const char *title, ZigStatusItemHandler zigTrayItemHandler) {
    NSString *pathToImageString = [NSString stringWithUTF8String:pathToImage];
    NSString *titleString = [NSString stringWithUTF8String:title];
    NSStatusItem *statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];

    if (pathToImageString.length > 0) {
        statusItem.button.image = [[NSImage alloc] initWithContentsOfFile:pathToImageString];
    }
    if (titleString.length > 0) {
        statusItem.button.title = titleString;
    }

    if (zigTrayItemHandler) {
        StatusItemTarget *target = [[StatusItemTarget alloc] init];
        target.statusItem = statusItem;
        target.zigHandler = zigTrayItemHandler;
        target.trayId = trayId;

        objc_setAssociatedObject(statusItem.button, "statusItemTarget", target, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        [statusItem.button setTarget:target];
        [statusItem.button setAction:@selector(statusItemClicked:)];
        
        // Ensure the button listens for both left and right mouse up events
        [statusItem.button sendActionOn:NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp];
    }
    
    retainObjCObject(statusItem);   

    return statusItem;
}

void setTrayTitle(NSStatusItem *statusItem, const char *title) {
    if (statusItem) {
        statusItem.button.title = [NSString stringWithUTF8String:title];
    }
}

void setTrayImage(NSStatusItem *statusItem, const char *image) {
    if (statusItem) {
        statusItem.button.image = [[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:image]];
    }
}

// application menus
// todo: consider consolidating with tray menus
NSMenu *createMenuFromConfig(NSArray *menuConfig, StatusItemTarget *target) {
    NSMenu *menu = [[NSMenu alloc] init];
    [menu setAutoenablesItems:NO];  // Disable auto-enabling of menu items

    for (NSDictionary *itemData in menuConfig) {
        NSString *type = itemData[@"type"];
        NSString *label = itemData[@"label"];
        NSString *action = itemData[@"action"];
        NSArray *submenuConfig = itemData[@"submenu"];
        NSString *role = itemData[@"role"];
        NSString *accelerator = itemData[@"accelerator"];
        NSNumber *modifierMask = itemData[@"modifierMask"];

        BOOL enabled = [itemData[@"enabled"] boolValue];
        BOOL checked = [itemData[@"checked"] boolValue];
        BOOL hidden = [itemData[@"hidden"] boolValue];
        NSString *tooltip = itemData[@"tooltip"];

        NSMenuItem *menuItem;

        if ([type isEqualToString:@"divider"]) {
            menuItem = [NSMenuItem separatorItem];
        } else {
            menuItem = [[NSMenuItem alloc] initWithTitle:label action:@selector(menuItemClicked:) keyEquivalent:@""];
            menuItem.representedObject = action;            
            

            if (role) {
                if ([role isEqualToString:@"quit"]) {
                    menuItem.action = @selector(terminate:);
                } else if ([role isEqualToString:@"hide"]) {
                    menuItem.action = @selector(hide:);
                } else if ([role isEqualToString:@"hideOthers"]) {
                    menuItem.action = @selector(hideOtherApplications:);
                } else if ([role isEqualToString:@"showAll"]) {
                    menuItem.action = @selector(unhideAllApplications:);
                } else if ([role isEqualToString:@"undo"]) {
                    menuItem.action = @selector(undo:);
                } else if ([role isEqualToString:@"redo"]) {
                    menuItem.action = @selector(redo:);
                } else if ([role isEqualToString:@"cut"]) {
                    menuItem.action = @selector(cut:);
                } else if ([role isEqualToString:@"copy"]) {
                    menuItem.action = @selector(copy:);
                } else if ([role isEqualToString:@"paste"]) {
                    menuItem.action = @selector(paste:);
                } else if ([role isEqualToString:@"pasteAndMatchStyle"]) {
                    menuItem.action = @selector(pasteAsPlainText:);
                } else if ([role isEqualToString:@"delete"]) {
                    menuItem.action = @selector(delete:);
                } else if ([role isEqualToString:@"selectAll"]) {
                    menuItem.action = @selector(selectAll:);
                } else if ([role isEqualToString:@"startSpeaking"]) {
                    menuItem.action = @selector(startSpeaking:);
                } else if ([role isEqualToString:@"stopSpeaking"]) {
                    menuItem.action = @selector(stopSpeaking:);
                } else if ([role isEqualToString:@"enterFullScreen"]) {
                    menuItem.action = @selector(enterFullScreen:);
                } else if ([role isEqualToString:@"exitFullScreen"]) {
                    menuItem.action = @selector(exitFullScreen:);
                } else if ([role isEqualToString:@"toggleFullScreen"]) {
                    menuItem.action = @selector(toggleFullScreen:);
                } else if ([role isEqualToString:@"minimize"]) {
                    menuItem.action = @selector(performMiniaturize:);
                } else if ([role isEqualToString:@"zoom"]) {
                    menuItem.action = @selector(performZoom:);
                } else if ([role isEqualToString:@"bringAllToFront"]) {
                    menuItem.action = @selector(arrangeInFront:);
                } else if ([role isEqualToString:@"close"]) {
                    menuItem.action = @selector(performClose:);
                } else if ([role isEqualToString:@"cycleThroughWindows"]) {
                    menuItem.action = @selector(selectNextKeyView:);
                } else if ([role isEqualToString:@"showHelp"]) {
                    menuItem.action = @selector(showHelp:);
                }

                if (!accelerator) {
                    // set 'default' keyboard shortcuts for given roles
                    if ([role isEqualToString:@"undo"]) {
                        menuItem.keyEquivalent = @"z";
                        menuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand;
                    } else if ([role isEqualToString:@"redo"]) {
                        menuItem.keyEquivalent = @"Z";
                        menuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
                    } else if ([role isEqualToString:@"cut"]) {
                        menuItem.keyEquivalent = @"x";
                        menuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand;
                    } else if ([role isEqualToString:@"copy"]) {
                        menuItem.keyEquivalent = @"c";
                        menuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand;
                    } else if ([role isEqualToString:@"paste"]) {
                        menuItem.keyEquivalent = @"v";
                        menuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand;
                    } else if ([role isEqualToString:@"pasteAndMatchStyle"]) {
                        menuItem.keyEquivalent = @"V";
                        menuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagOption;
                    } else if ([role isEqualToString:@"delete"]) {
                        menuItem.keyEquivalent = [NSString stringWithFormat:@"%c", (char)NSDeleteCharacter]; // Delete key
                        menuItem.keyEquivalentModifierMask = 0;
                    } else if ([role isEqualToString:@"selectAll"]) {
                        menuItem.keyEquivalent = @"a";
                        menuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand;
                    }
                }
            } else {
                // Note: if we set the target it will look for the method on the target. eg: copy instead
                // of letting the os handle it
                menuItem.target = target;            
            }

            if (accelerator) {
                menuItem.keyEquivalent = accelerator;
                if (modifierMask) {
                    menuItem.keyEquivalentModifierMask = [modifierMask unsignedIntegerValue];
                } else {
                    menuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand; // Default to Command key if no modifier specified
                }
            } 

            menuItem.enabled = enabled;
            menuItem.state = checked ? NSControlStateValueOn : NSControlStateValueOff;
            menuItem.hidden = hidden;
            menuItem.toolTip = tooltip;

            if (submenuConfig) {
                NSMenu *submenu = createMenuFromConfig(submenuConfig, target);
                [menu setSubmenu:submenu forItem:menuItem];
            }
        }
        [menu addItem:menuItem];
    }

    return menu;
}

void setTrayMenuFromJSON(NSStatusItem *statusItem, const char *jsonString) {    
    if (statusItem) {
        StatusItemTarget *target = objc_getAssociatedObject(statusItem.button, "statusItemTarget");

        NSData *jsonData = [NSData dataWithBytes:jsonString length:strlen(jsonString)];
        NSError *error;
        NSArray *menuArray = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&error];

        if (error) {
            NSLog(@"Failed to parse JSON: %@", error);
            return;
        }

        NSMenu *menu = createMenuFromConfig(menuArray, target);
        [statusItem setMenu:menu];
    }
}

void setTrayMenu(NSStatusItem *statusItem, const char *menuConfig) {    
    if (statusItem) {
        setTrayMenuFromJSON(statusItem, menuConfig);        
    }
}




void setApplicationMenu(const char *jsonString, ZigStatusItemHandler zigTrayItemHandler) {
    NSLog(@"Setting application menu from JSON in objc");

    NSData *jsonData = [NSData dataWithBytes:jsonString length:strlen(jsonString)];
    NSError *error;
    NSArray *menuArray = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&error];

    if (error) {
        NSLog(@"Failed to parse JSON: %@", error);
        return;
    }

    // Note: consider using a generic target for both system tray and application menu
    // for now we just create a status item that just serves as a way to reference the zig menu click handler
    StatusItemTarget *target = [[StatusItemTarget alloc] init];
    target.zigHandler = zigTrayItemHandler;
    target.trayId = 0;
    NSMenu *menu = createMenuFromConfig(menuArray, target);
    
    objc_setAssociatedObject(NSApp, "AppMenuTarget", target, OBJC_ASSOCIATION_RETAIN_NONATOMIC);


    [NSApp setMainMenu:menu];
}