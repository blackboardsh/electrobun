#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <Cocoa/Cocoa.h>
#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonCrypto.h>
#import <QuartzCore/QuartzCore.h>

// CEF
#include "include/base/cef_ref_counted.h"
#include "include/base/cef_logging.h"
#include "include/cef_base.h"
#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_browser.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_application_mac.h"
#include "include/wrapper/cef_library_loader.h"
#include "include/wrapper/cef_helpers.h"
#include <list>

// Forward declare the CEF classes
class CefApp;
class CefClient;
class CefLifeSpanHandler;
class CefBrowser;

// temp: make this useCEF and make it configurable
BOOL useCEF = true;

// ----------------------------------------------------------------------------
// 1) DATA STRUCTS, TYPEDEFS, AND UTILITY
// ----------------------------------------------------------------------------


/** Matches your existing "views:// schema" file response. */
typedef struct {
    const char *mimeType;
    const char *fileContents;
    size_t len;
    void *opaquePointer;
} FileResponse;

/** The callback type you use for "views://" resource loading. */
typedef FileResponse (*zigStartURLSchemeTaskCallback)(uint32_t webviewId, const char* url, const char* body);

/** Generic bridging callback types. */
typedef BOOL (*DecideNavigationCallback)(uint32_t webviewId, const char* url);
typedef void (*WebviewEventHandler)(uint32_t webviewId, const char* type, const char* url);
typedef BOOL (*HandlePostMessage)(uint32_t webviewId, const char* message);
typedef const char* (*HandlePostMessageWithReply)(uint32_t webviewId, const char* message);
typedef void (*callAsyncJavascriptCompletionHandler)(const char *messageId, uint32_t webviewId, uint32_t hostWebviewId, const char *responseJSON);

/** Window style mask config. */
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

/** Window event callbacks. */
typedef void (*WindowCloseHandler)(uint32_t windowId);
typedef void (*WindowMoveHandler)(uint32_t windowId, CGFloat x, CGFloat y);
typedef void (*WindowResizeHandler)(uint32_t windowId, CGFloat x, CGFloat y, CGFloat width, CGFloat height);

/** Tray and menu bridging. */
typedef void (*ZigStatusItemHandler)(uint32_t trayId, const char *action);
typedef void (*MenuHandler)(const char *menuItemId);

/** Snapshot callback. */
typedef void (*zigSnapshotCallback)(uint32_t hostId, uint32_t webviewId, const char * dataUrl);

// A convenience function for manual memory management (if you're not using ARC).
void retainObjCObject(id objcObject) {
    CFRetain((__bridge CFTypeRef)objcObject);
}
void releaseObjCObject(id objcObject) {
    CFRelease((__bridge CFTypeRef)objcObject);
}

// CEF SCHEMA HANDLER

#include <cstdint>

// Match the existing callback type
typedef FileResponse (*zigStartURLSchemeTaskCallback)(uint32_t webviewId, const char* url, const char* body);
#include "include/cef_scheme.h"
#include "include/cef_resource_handler.h"
#include <string>
#include <vector>

// Forward declarations
class ElectrobunSchemeHandler;
class ElectrobunSchemeHandlerFactory;

// The main scheme handler class
class ElectrobunSchemeHandler : public CefResourceHandler {
public:
     ElectrobunSchemeHandler(zigStartURLSchemeTaskCallback callback, uint32_t webviewId)
        : fileLoader_(callback)
        , webviewId_(webviewId)
        , hasResponse_(false)
        , offset_(0) {
        
    }

     bool Open(CefRefPtr<CefRequest> request,
             bool& handle_request,
             CefRefPtr<CefCallback> callback) override {
        std::string url = request->GetURL().ToString();
        
        
        
        FileResponse response = fileLoader_(webviewId_, url.c_str(), nullptr);
        
        if (response.fileContents && response.len > 0) {            
            
            // Print first 32 bytes of content for debugging
            std::string preview;
            const char* content = response.fileContents;
            for (size_t i = 0; i < std::min(response.len, size_t(32)); i++) {
                if (isprint(content[i])) {
                    preview += content[i];
                } else {
                    char hex[8];
                    snprintf(hex, sizeof(hex), "\\x%02x", (unsigned char)content[i]);
                    preview += hex;
                }
            }
            
            
            mimeType_ = response.mimeType ? response.mimeType : "text/html";
            responseData_.assign(response.fileContents, response.fileContents + response.len);
            hasResponse_ = true;
            handle_request = true;
            return true;
        }
        
        
        handle_request = false;
        return false;
    }

    void GetResponseHeaders(CefRefPtr<CefResponse> response,
                          int64_t& response_length,
                          CefString& redirectUrl) override {
        if (!hasResponse_) {
            response->SetStatus(404);
            response_length = 0;
            
            return;
        }

        response->SetMimeType(mimeType_);
        response->SetStatus(200);
        response_length = responseData_.size();

        CefResponse::HeaderMap headers;
        headers.insert(std::make_pair("Access-Control-Allow-Origin", "*"));
        response->SetHeaderMap(headers);
        
        
    }

    bool Read(void* data_out,
             int bytes_to_read,
             int& bytes_read,
             CefRefPtr<CefResourceReadCallback> callback) override {
        bytes_read = 0;
        if (!hasResponse_ || offset_ >= responseData_.size()) {
            
            return false;
        }

        size_t remaining = responseData_.size() - offset_;
        bytes_read = std::min(bytes_to_read, static_cast<int>(remaining));
        memcpy(data_out, responseData_.data() + offset_, bytes_read);
        offset_ += bytes_read;

        
        return true;
    }

    void Cancel() override {
        // NSLog(@"[CEF] Scheme Handler: Request cancelled");
    }

private:
    zigStartURLSchemeTaskCallback fileLoader_;
    uint32_t webviewId_;
    std::string mimeType_;
    std::vector<char> responseData_;
    bool hasResponse_;
    size_t offset_;
    
    IMPLEMENT_REFCOUNTING(ElectrobunSchemeHandler);
    DISALLOW_COPY_AND_ASSIGN(ElectrobunSchemeHandler);
};


// The factory class that creates scheme handlers
class ElectrobunSchemeHandlerFactory : public CefSchemeHandlerFactory {
public:
     ElectrobunSchemeHandlerFactory(zigStartURLSchemeTaskCallback callback, uint32_t webviewId)
        : fileLoader_(callback), webviewId_(webviewId) {}

        CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> browser,
                                       CefRefPtr<CefFrame> frame,
                                       const CefString& scheme_name,
                                       CefRefPtr<CefRequest> request) override {
        
            return new ElectrobunSchemeHandler(fileLoader_, webviewId_);
        }

private:
    zigStartURLSchemeTaskCallback fileLoader_;
    uint32_t webviewId_;
    
    IMPLEMENT_REFCOUNTING(ElectrobunSchemeHandlerFactory);
    DISALLOW_COPY_AND_ASSIGN(ElectrobunSchemeHandlerFactory);
};

// ----------------------------------------------------------------------------
// 2) ABSTRACT BASE CLASS
// ----------------------------------------------------------------------------
@interface AbstractWebView : NSObject

- (void *)nativeView;

- (void)loadURL:(const char *)urlString;
- (void)goBack;
- (void)goForward;
- (void)reload;
- (void)remove;

- (void)setTransparent:(BOOL)transparent;
- (void)toggleMirroring:(BOOL)enable;
- (void)setPassthrough:(BOOL)enable;
- (void)setHidden:(BOOL)hidden;
- (void)resize:(NSRect)frame withMasksJSON:(const char *)masksJson;

- (BOOL)canGoBack;
- (BOOL)canGoForward;

- (void)evaluateJavaScriptWithNoCompletion:(const char*)jsString;
- (void)evaluateJavaScriptInSecureContentWorld:(const char*)jsString;
- (void)callAsyncJavascript:(const char*)messageId jsString:(const char*)jsString webviewId:(uint32_t)webviewId hostWebviewId:(uint32_t)hostWebviewId completionHandler:(callAsyncJavascriptCompletionHandler)completionHandler;
- (void)addPreloadScriptToWebView:(const char*)jsString;
- (void)updateCustomPreloadScript:(const char*)jsString;


@end

@implementation AbstractWebView
- (void *)nativeView {
    [self doesNotRecognizeSelector:_cmd];
    return nil;
}
- (void)loadURL:(const char *)urlString { [self doesNotRecognizeSelector:_cmd]; }
- (void)goBack { [self doesNotRecognizeSelector:_cmd]; }
- (void)goForward { [self doesNotRecognizeSelector:_cmd]; }
- (void)reload { [self doesNotRecognizeSelector:_cmd]; }
- (void)remove { [self doesNotRecognizeSelector:_cmd]; }

- (void)setTransparent:(BOOL)transparent { [self doesNotRecognizeSelector:_cmd]; }
- (void)toggleMirroring:(BOOL)enable { [self doesNotRecognizeSelector:_cmd]; }
- (void)setPassthrough:(BOOL)enable { [self doesNotRecognizeSelector:_cmd]; }
- (void)setHidden:(BOOL)hidden { [self doesNotRecognizeSelector:_cmd]; }
- (void)resize:(NSRect)frame withMasksJSON:(const char *)masksJson { [self doesNotRecognizeSelector:_cmd]; }

- (BOOL)canGoBack { [self doesNotRecognizeSelector:_cmd]; return NO; }
- (BOOL)canGoForward { [self doesNotRecognizeSelector:_cmd]; return NO; }

- (void)evaluateJavaScriptWithNoCompletion:(const char*)jsString { [self doesNotRecognizeSelector:_cmd]; }
- (void)evaluateJavaScriptInSecureContentWorld:(const char*)jsString { [self doesNotRecognizeSelector:_cmd]; }
- (void)callAsyncJavascript:(const char*)messageId jsString:(const char*)jsString webviewId:(uint32_t)webviewId hostWebviewId:(uint32_t)hostWebviewId completionHandler:(callAsyncJavascriptCompletionHandler)completionHandler { [self doesNotRecognizeSelector:_cmd]; }
// todo: we don't need this to be public since it's only used to set the internal electrobun preview script
- (void)addPreloadScriptToWebView:(const char*)jsString { [self doesNotRecognizeSelector:_cmd]; }
- (void)updateCustomPreloadScript:(const char*)jsString { [self doesNotRecognizeSelector:_cmd]; }
@end


// ----------------------------------------------------------------------------
// 3) TRANSPARENT WKWEBVIEW CLASS
// ----------------------------------------------------------------------------

@interface TransparentWKWebView : WKWebView
@property (nonatomic, assign) BOOL isMousePassthroughEnabled;
@property (nonatomic, assign) BOOL mirrorModeEnabled;
@property (nonatomic, assign) TransparentWKWebView *hostView; // optional
@property (nonatomic, assign) uint32_t webviewId;
@property (nonatomic, assign) BOOL fullSize;
@property (nonatomic, assign) AbstractWebView *abstractView;

- (void)toggleMirrorMode:(BOOL)enabled;
@end

@implementation TransparentWKWebView

- (instancetype)initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    self = [super initWithFrame:frame configuration:configuration];
    if (self) {
        self.frame = frame;
        _mirrorModeEnabled = NO;
        _isMousePassthroughEnabled = NO;
        _fullSize = NO;
    }
    return self;
}

- (NSView *)hitTest:(NSPoint)point {
    if (self.isMousePassthroughEnabled) {
        return nil; // pass through all mouse events
    }
    return [super hitTest:point];
}

- (void)toggleMirrorMode:(BOOL)enable {
    if (self.mirrorModeEnabled == enable) {
        return;
    }
    BOOL isLeftMouseButtonDown = ([NSEvent pressedMouseButtons] & (1 << 0)) != 0;
    if (isLeftMouseButtonDown) {
        return;
    }
    self.mirrorModeEnabled = enable;
    if (enable) {
        CGFloat positionX = self.frame.origin.x;
        CGFloat positionY = self.frame.origin.y;
        CGFloat OFFSCREEN_OFFSET = -20000;
        self.frame = CGRectOffset(self.frame, OFFSCREEN_OFFSET, OFFSCREEN_OFFSET);
        self.layer.position = CGPointMake(positionX, positionY);
    } else {
        self.frame = CGRectMake(self.layer.position.x,
                                self.layer.position.y,
                                self.frame.size.width,
                                self.frame.size.height);
    }
}

@end

// ----------------------------------------------------------------------------
// 4) CREATE DATA STORE + URL SCHEME HANDLER
// ----------------------------------------------------------------------------

WKWebsiteDataStore* createDataStoreForPartition(const char* partitionIdentifier);

NSUUID *UUIDFromString(NSString *string) {
    unsigned char hash[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(string.UTF8String, (CC_LONG)string.length, hash);
    uuid_t uuid;
    memcpy(uuid, hash, sizeof(uuid));
    return [[NSUUID alloc] initWithUUIDBytes:uuid];
}

WKWebsiteDataStore* createDataStoreForPartition(const char* partitionIdentifier) {
    NSString *identifier = [NSString stringWithUTF8String:partitionIdentifier];
    if ([identifier hasPrefix:@"persist:"]) {
        // persistent
        identifier = [identifier substringFromIndex:8];
        NSUUID *uuid = UUIDFromString(identifier);
        if (uuid) {
            return [WKWebsiteDataStore dataStoreForIdentifier:uuid];
        } else {
            NSLog(@"Invalid UUID for identifier: %@", identifier);
            return [WKWebsiteDataStore defaultDataStore];
        }
    } else {
        // ephemeral
        return [WKWebsiteDataStore nonPersistentDataStore];
    }
}

@interface MyURLSchemeHandler : NSObject <WKURLSchemeHandler>
@property (nonatomic, assign) zigStartURLSchemeTaskCallback fileLoader;
@property (nonatomic, assign) uint32_t webviewId;
@end

@implementation MyURLSchemeHandler
- (void)webView:(WKWebView *)webView
startURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
    NSURL *url = urlSchemeTask.request.URL;
    NSData *bodyData = urlSchemeTask.request.HTTPBody;
    NSString *bodyString = bodyData ? [[NSString alloc] initWithData:bodyData encoding:NSUTF8StringEncoding] : @"";
    if (self.fileLoader) {
        FileResponse fileResponse = self.fileLoader(self.webviewId, url.absoluteString.UTF8String, bodyString.UTF8String);

        NSString *mimeType = fileResponse.mimeType ? [NSString stringWithUTF8String:fileResponse.mimeType] : @"application/octet-stream";
        if ([mimeType isEqualToString:@"screenshot"]) {
            // special case
            WKSnapshotConfiguration *snapshotConfig = [[WKSnapshotConfiguration alloc] init];
            WKWebView *targetWebview = (__bridge WKWebView *)fileResponse.opaquePointer;
            [targetWebview takeSnapshotWithConfiguration:snapshotConfig completionHandler:^(NSImage *snapshotImage, NSError *error) {
                if (error) {
                    NSLog(@"Error capturing snapshot: %@", error);
                    return;
                }
                NSBitmapImageRep *imgRepbmp = [[NSBitmapImageRep alloc] initWithData:[snapshotImage TIFFRepresentation]];
                NSData *imgData = [imgRepbmp representationUsingType:NSBitmapImageFileTypeBMP properties:@{NSImageCompressionFactor: @1.0}];

                NSURLResponse *response = [[NSURLResponse alloc] initWithURL:url
                                                                    MIMEType:@"image/bmp"
                                                       expectedContentLength:imgData.length
                                                            textEncodingName:nil];
                [urlSchemeTask didReceiveResponse:response];
                [urlSchemeTask didReceiveData:imgData];
                [urlSchemeTask didFinish];
            }];
        } else {
            // normal resource
            NSData *data = [NSData dataWithBytes:fileResponse.fileContents length:fileResponse.len];
            NSURLResponse *response = [[NSURLResponse alloc] initWithURL:url
                                                                MIMEType:mimeType
                                                   expectedContentLength:data.length
                                                        textEncodingName:nil];
            [urlSchemeTask didReceiveResponse:response];
            [urlSchemeTask didReceiveData:data];
            [urlSchemeTask didFinish];
        }
    }
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
    NSLog(@"Stopping URL scheme task for URL: %@", urlSchemeTask.request.URL);
}
@end

@interface ContainerView : NSView
@end

@implementation ContainerView
- (instancetype)initWithFrame:(NSRect)frameRect {
    self = [super initWithFrame:frameRect];
    if (self) {
        [self updateTrackingAreas];
    }
    return self;
}

- (void)updateTrackingAreas {
    NSLog(@"Updating tracking areas");
    for (NSTrackingArea *area in self.trackingAreas) {
        [self removeTrackingArea:area];
    }
    NSTrackingArea *mouseTrackingArea = [[NSTrackingArea alloc] initWithRect:self.bounds
        options:NSTrackingMouseMoved | NSTrackingActiveInKeyWindow
        owner:self
        userInfo:nil];
    [self addTrackingArea:mouseTrackingArea];
}

- (void)mouseMoved:(NSEvent *)event {
    // NSLog(@"mouseMoved");
    NSPoint mouseLocation = [self convertPoint:[event locationInWindow] fromView:nil];
    [self updateActiveWebviewForMousePosition:mouseLocation];
}

// This function tries to figure out which "TransparentWKWebView" should be interactive
// vs mirrored, based on mouse position and layering.
- (void)updateActiveWebviewForMousePosition:(NSPoint)mouseLocation {
    // NSLog(@"updateActiveWebviewForMousePosition");
    NSArray *subviews = [self subviews];
    BOOL stillSearching = YES;
    
    for (NSView *view in [subviews reverseObjectEnumerator]) {
        if (![view isKindOfClass:[TransparentWKWebView class]]) {            
            continue;  
        }
        
        TransparentWKWebView *subview = (TransparentWKWebView *)view;

        if (stillSearching) {
            NSRect subviewRenderLayerFrame = subview.layer.frame;
            if (NSPointInRect(mouseLocation, subviewRenderLayerFrame) && !subview.hidden) {
                CAShapeLayer *maskLayer = (CAShapeLayer *)subview.layer.mask;
                CGPathRef maskPath = maskLayer ? maskLayer.path : NULL;
                if (maskPath) {
                    CGPoint mousePositionInMaskPath = CGPointMake(mouseLocation.x - subviewRenderLayerFrame.origin.x,
                                                                  subviewRenderLayerFrame.size.height - (mouseLocation.y - subviewRenderLayerFrame.origin.y));
                    if (!CGPathContainsPoint(maskPath, NULL, mousePositionInMaskPath, true)) {
                        [subview toggleMirrorMode:YES];                        
                        continue;
                    }
                }
                [subview toggleMirrorMode:NO];
                stillSearching = NO;
                continue;
            }
        }
        [subview toggleMirrorMode:YES];
    }    
}
@end
// ----------------------------------------------------------------------------
// 18) NAVIGATION & UI DELEGATES
// ----------------------------------------------------------------------------

@interface MyNavigationDelegate : NSObject <WKNavigationDelegate>
@property (nonatomic, assign) DecideNavigationCallback zigCallback;
@property (nonatomic, assign) WebviewEventHandler zigEventHandler;
@property (nonatomic, assign) uint32_t webviewId;
@end

@implementation MyNavigationDelegate
- (void)webView:(WKWebView *)webView
decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *newURL = navigationAction.request.URL;
    BOOL shouldAllow = self.zigCallback(self.webviewId, newURL.absoluteString.UTF8String);
    self.zigEventHandler(self.webviewId, "will-navigate", webView.URL.absoluteString.UTF8String);
    decisionHandler(shouldAllow ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    self.zigEventHandler(self.webviewId, "did-navigate", webView.URL.absoluteString.UTF8String);
}
- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    self.zigEventHandler(self.webviewId, "did-commit-navigation", webView.URL.absoluteString.UTF8String);
}
@end

@interface MyWebViewUIDelegate : NSObject <WKUIDelegate>
@property (nonatomic, assign) WebviewEventHandler zigEventHandler;
@property (nonatomic, assign) uint32_t webviewId;
@end

@implementation MyWebViewUIDelegate
- (WKWebView *)webView:(WKWebView *)webView
createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
     forNavigationAction:(WKNavigationAction *)navigationAction
          windowFeatures:(WKWindowFeatures *)windowFeatures {
    if (!navigationAction.targetFrame.isMainFrame) {
        self.zigEventHandler(self.webviewId, "new-window-open", navigationAction.request.URL.absoluteString.UTF8String);
    }
    return nil;
}
@end

// ----------------------------------------------------------------------------
// 19) POSTMESSAGE HANDLERS
// ----------------------------------------------------------------------------

@interface MyScriptMessageHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, assign) HandlePostMessage zigCallback;
@property (nonatomic, assign) uint32_t webviewId;
@end

@implementation MyScriptMessageHandler
- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    NSString *body = message.body;
    self.zigCallback(self.webviewId, body.UTF8String);
}
@end

// extern "C" MyScriptMessageHandler* addScriptMessageHandler(WKWebView *webView,
//                                                            uint32_t webviewId,
//                                                            const char *name,
//                                                            HandlePostMessage callback) {
//     MyScriptMessageHandler *handler = [[MyScriptMessageHandler alloc] init];
//     handler.zigCallback = callback;
//     handler.webviewId = webviewId;
//     [webView.configuration.userContentController addScriptMessageHandler:handler
//                                                                     name:[NSString stringWithUTF8String:name ?: ""]];
//     NSString *key = [NSString stringWithFormat:@"PostMessageHandler{%s}", name];
//     objc_setAssociatedObject(webView, key.UTF8String, handler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
//     return handler;
// }

@interface MyScriptMessageHandlerWithReply : NSObject <WKScriptMessageHandlerWithReply>
@property (nonatomic, assign) HandlePostMessageWithReply zigCallback;
@property (nonatomic, assign) uint32_t webviewId;
@end

@implementation MyScriptMessageHandlerWithReply
- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message
                  replyHandler:(void (^)(id _Nullable, NSString * _Nullable))replyHandler {
    NSString *body = message.body;
    const char *response = self.zigCallback(self.webviewId, body.UTF8String);
    NSString *responseNSString = [NSString stringWithUTF8String:response ?: ""];
    replyHandler(responseNSString, nil);
}
@end

extern "C" MyScriptMessageHandlerWithReply* addScriptMessageHandlerWithReply(WKWebView *webView,
                                                                             uint32_t webviewId,
                                                                             const char *name,
                                                                             HandlePostMessageWithReply callback) {
    MyScriptMessageHandlerWithReply *handler = [[MyScriptMessageHandlerWithReply alloc] init];
    handler.zigCallback = callback;
    handler.webviewId = webviewId;
    [webView.configuration.userContentController addScriptMessageHandlerWithReply:handler
                                                                     contentWorld:WKContentWorld.pageWorld
                                                                             name:[NSString stringWithUTF8String:name ?: ""]];
    NSString *key = [NSString stringWithFormat:@"PostMessageHandlerWithReply{%s}", name];
    objc_setAssociatedObject(webView, key.UTF8String, handler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return handler;
}


// ----------------------------------------------------------------------------
// 14) RESIZEWEBVIEW IMPLEMENTATION
// ----------------------------------------------------------------------------

NSArray<NSValue *> *addOverlapRects(NSArray<NSDictionary *> *rectsArray) {
    NSMutableArray<NSValue *> *resultingRects = [NSMutableArray array];
    for (NSDictionary *rectDict in rectsArray) {
        CGFloat x = [rectDict[@"x"] floatValue];
        CGFloat y = [rectDict[@"y"] floatValue];
        CGFloat w = [rectDict[@"width"] floatValue];
        CGFloat h = [rectDict[@"height"] floatValue];
        NSRect newRect = NSMakeRect(x, y, w, h);

        NSMutableArray<NSValue *> *overlapRects = [NSMutableArray array];
        for (NSValue *existingRectValue in resultingRects) {
            NSRect existingRect = [existingRectValue rectValue];
            if (NSIntersectsRect(existingRect, newRect)) {
                NSRect overlapRect = NSIntersectionRect(existingRect, newRect);
                if (!NSIsEmptyRect(overlapRect)) {
                    [overlapRects addObject:[NSValue valueWithRect:overlapRect]];
                }
            }
        }
        [resultingRects addObject:[NSValue valueWithRect:newRect]];
        [resultingRects addObjectsFromArray:overlapRects];
    }
    return resultingRects;
}

// ----------------------------------------------------------------------------
// 5) WKWEBVIEWIMPL SUBCLASS
// ----------------------------------------------------------------------------



@interface WKWebViewImpl : AbstractWebView
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, assign) uint32_t webviewId;

- (instancetype)initWithWebviewId:(uint32_t)webviewId
                           window:(NSWindow *)window   
                           url:(const char *)url                                                
                            frame:(NSRect)frame
                  assetFileLoader:(zigStartURLSchemeTaskCallback)assetFileLoader
                       autoResize:(bool)autoResize
              partitionIdentifier:(const char *)partitionIdentifier
              navigationCallback:(DecideNavigationCallback)navigationCallback
              webviewEventHandler:(WebviewEventHandler)webviewEventHandler
              bunBridgeHandler:(HandlePostMessage)bunBridgeHandler
              webviewTagBridgeHandler:(HandlePostMessage)webviewTagBridgeHandler
              electrobunPreloadScript:(const char *)electrobunPreloadScript
              customPreloadScript:(const char *)customPreloadScript;

@end

@implementation WKWebViewImpl

- (instancetype)initWithWebviewId:(uint32_t)webviewId
                           window:(NSWindow *)window
                           url:(const char *)url                                                   
                            frame:(NSRect)frame
                  assetFileLoader:(zigStartURLSchemeTaskCallback)assetFileLoader
                       autoResize:(bool)autoResize
              partitionIdentifier:(const char *)partitionIdentifier
              navigationCallback:(DecideNavigationCallback)navigationCallback
              webviewEventHandler:(WebviewEventHandler)webviewEventHandler
              bunBridgeHandler:(HandlePostMessage)bunBridgeHandler
              webviewTagBridgeHandler:(HandlePostMessage)webviewTagBridgeHandler
              electrobunPreloadScript:(const char *)electrobunPreloadScript
              customPreloadScript:(const char *)customPreloadScript
{
    self = [super init];
    if (self) {        
        _webviewId = webviewId;

        // TODO: rewrite this so we can return a reference to the AbstractRenderer and then call
        // init from zig after the handle is added to the webviewMap then we don't need this async stuff
        dispatch_async(dispatch_get_main_queue(), ^{
        
        

            // configuration
            WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
            configuration.websiteDataStore = createDataStoreForPartition(partitionIdentifier);
            [configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];        
            [configuration.preferences setValue:@YES forKey:@"elementFullscreenEnabled"];

            // Add scheme handler
            MyURLSchemeHandler *assetSchemeHandler = [[MyURLSchemeHandler alloc] init];
            assetSchemeHandler.fileLoader = assetFileLoader;
            assetSchemeHandler.webviewId = webviewId;
            [configuration setURLSchemeHandler:assetSchemeHandler forURLScheme:@"views"];

            // create TransparentWKWebView
            TransparentWKWebView *wv = [[TransparentWKWebView alloc] initWithFrame:frame configuration:configuration];
            wv.webviewId = webviewId;
            [wv setValue:@NO forKey:@"drawsBackground"];
            wv.layer.backgroundColor = [[NSColor clearColor] CGColor];
            wv.layer.opaque = NO;

            if (autoResize) {
                wv.autoresizingMask = NSViewNotSizable;
                wv.fullSize = YES;
            } else {
                wv.autoresizingMask = NSViewNotSizable;
                wv.fullSize = NO;
            }
            retainObjCObject(wv);

            // delegates
            MyNavigationDelegate *navigationDelegate = [[MyNavigationDelegate alloc] init];
            navigationDelegate.zigCallback = navigationCallback;
            navigationDelegate.zigEventHandler = webviewEventHandler;
            navigationDelegate.webviewId = webviewId;
            wv.navigationDelegate = navigationDelegate;
            objc_setAssociatedObject(wv, "NavigationDelegate", navigationDelegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

            MyWebViewUIDelegate *uiDelegate = [[MyWebViewUIDelegate alloc] init];
            uiDelegate.zigEventHandler = webviewEventHandler;
            uiDelegate.webviewId = webviewId;
            wv.UIDelegate = uiDelegate;
            objc_setAssociatedObject(wv, "UIDelegate", uiDelegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);                                    

            // postmessage
            // bunBridge
            MyScriptMessageHandler *bunHandler = [[MyScriptMessageHandler alloc] init];
            bunHandler.zigCallback = bunBridgeHandler;
            bunHandler.webviewId = webviewId;
            [wv.configuration.userContentController addScriptMessageHandler:bunHandler
                                                                            name:[NSString stringWithUTF8String:"bunBridge"]];

            objc_setAssociatedObject(wv, "bunBridgeHandler", bunHandler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

            // webviewTagBridge
            MyScriptMessageHandler *webviewTagHandler = [[MyScriptMessageHandler alloc] init];
            webviewTagHandler.zigCallback = webviewTagBridgeHandler;
            webviewTagHandler.webviewId = webviewId;
            [wv.configuration.userContentController addScriptMessageHandler:webviewTagHandler
                                                                            name:[NSString stringWithUTF8String:"webviewTagBridge"]];

            objc_setAssociatedObject(wv, "webviewTagHandler", webviewTagHandler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

            // add subview
            [window.contentView addSubview:wv positioned:NSWindowAbove relativeTo:nil];
            CGFloat adjustedY = window.contentView.bounds.size.height - frame.origin.y - frame.size.height;
            wv.frame = NSMakeRect(frame.origin.x, adjustedY, frame.size.width, frame.size.height);

            wv.abstractView = self;

            // Force the load to happen on the next runloop iteration after addSubview
            // otherwise wkwebkit won't load
            dispatch_async(dispatch_get_main_queue(), ^{
                if (url) {                
                    [self loadURL:url];
                } 
            });

            _webView = wv;

            [self addPreloadScriptToWebView:electrobunPreloadScript];
            [self updateCustomPreloadScript:customPreloadScript];
            
            // associate
            objc_setAssociatedObject(_webView, "WKWebViewImpl", self, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        });
    }
    return self;
}

#pragma mark - AbstractWebView overrides

- (void *)nativeView {
    return (__bridge void *)self.webView;
}

- (void)loadURL:(const char *)urlString {    
    NSString *urlNSString = (urlString ? [NSString stringWithUTF8String:urlString] : @"");
    NSURL *url = [NSURL URLWithString:urlNSString];
    if (!url) return;
    NSURLRequest *request = [NSURLRequest requestWithURL:url];
    [self.webView loadRequest:request];
}

- (void)goBack {
    [self.webView goBack];
}
- (void)goForward {
    [self.webView goForward];
}
- (void)reload {
    [self.webView reload];
}

- (void)remove {
    [self.webView stopLoading];
    [self.webView removeFromSuperview];
    self.webView.navigationDelegate = nil;
    self.webView.UIDelegate = nil;
    [self.webView evaluateJavaScript:@"document.body.innerHTML='';" completionHandler:nil];
    releaseObjCObject(self.webView);
    self.webView = nil;
}

- (void)setTransparent:(BOOL)transparent {
    if (transparent) {
        self.webView.layer.opacity = 0;
    } else {
        self.webView.layer.opacity = 1;
    }
}

- (void)toggleMirroring:(BOOL)enable {
    TransparentWKWebView *twv = (TransparentWKWebView *)self.webView;
    [twv toggleMirrorMode:enable];
}

- (void)setPassthrough:(BOOL)enable {
    TransparentWKWebView *twv = (TransparentWKWebView *)self.webView;
    twv.isMousePassthroughEnabled = enable;
}

- (void)setHidden:(BOOL)hidden {
    [self.webView setHidden:hidden];
}

// extern "C" void resizeWebview(TransparentWKWebView *view, NSRect frame, const char *masksJson);

- (void)resize:(NSRect)frame withMasksJSON:(const char *)masksJson {
    if (!self.webView) return;
    TransparentWKWebView *twv = (TransparentWKWebView *)self.webView;        

    // NSLog(@"resizeWebview  %f, %f, %f, %f", frame.origin.x, frame.origin.y, frame.size.width, frame.size.height);
    CGFloat adjustedX = floor(frame.origin.x);
    CGFloat adjustedWidth = ceilf(frame.size.width);
    CGFloat adjustedHeight = ceilf(frame.size.height);
    CGFloat adjustedY = floor(twv.superview.bounds.size.height - ceilf(frame.origin.y) - adjustedHeight);

    if (twv.mirrorModeEnabled) {
        twv.frame = NSMakeRect(-20000, -20000, adjustedWidth, adjustedHeight);
        twv.layer.position = CGPointMake(adjustedX, adjustedY);
    } else {
        twv.frame = NSMakeRect(adjustedX, adjustedY, adjustedWidth, adjustedHeight);
    }

    if (!masksJson || strlen(masksJson) == 0) {
        twv.layer.mask = nil;
        return;
    }

    NSString *jsonString = [NSString stringWithUTF8String:masksJson ?: ""];
    NSData *jsonData = [jsonString dataUsingEncoding:NSUTF8StringEncoding];
    if (!jsonData) {
        twv.layer.mask = nil;
        return;
    }
    NSError *error = nil;
    NSArray *rectsArray = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&error];
    if (!rectsArray || error) {
        twv.layer.mask = nil;
        return;
    }
    NSArray<NSValue *> *processedRects = addOverlapRects(rectsArray);

    CAShapeLayer *maskLayer = [CAShapeLayer layer];
    maskLayer.frame = twv.layer.bounds;
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathAddRect(path, NULL, maskLayer.bounds);

    for (NSValue *rectValue in processedRects) {
        NSRect rect = [rectValue rectValue];
        CGPathAddRect(path, NULL, rect);
    }
    maskLayer.fillRule = kCAFillRuleEvenOdd;
    maskLayer.path = path;
    twv.layer.mask = maskLayer;

    NSPoint currentMousePosition = [twv.window mouseLocationOutsideOfEventStream];
    ContainerView *containerView = (ContainerView *)twv.superview;
    [containerView updateActiveWebviewForMousePosition:currentMousePosition];
    CGPathRelease(path);
}

- (BOOL)canGoBack {
    return [self.webView canGoBack];
}
- (BOOL)canGoForward {
    return [self.webView canGoForward];
}

- (void)evaluateJavaScriptWithNoCompletion:(const char*)jsString {
    WKContentWorld *isolatedWorld = [WKContentWorld pageWorld];
    NSString *code = (jsString ? [NSString stringWithUTF8String:jsString] : @"");
    [self.webView evaluateJavaScript:code
                             inFrame:nil
                     inContentWorld:isolatedWorld
                   completionHandler:nil];
}

- (void)evaluateJavaScriptInSecureContentWorld:(const char*)jsString {
    WKContentWorld *secureWorld = [WKContentWorld worldWithName:@"ElectrobunSecureWorld"];
    NSString *code = (jsString ? [NSString stringWithUTF8String:jsString] : @"");
    [self.webView evaluateJavaScript:code
                             inFrame:nil
                     inContentWorld:secureWorld
                   completionHandler:nil];
}

- (void)callAsyncJavascript:(const char*)messageId jsString:(const char*)jsString webviewId:(uint32_t)webviewId hostWebviewId:(uint32_t)hostWebviewId completionHandler:(callAsyncJavascriptCompletionHandler)completionHandler {
    NSString *javaScript = [NSString stringWithUTF8String:jsString ?: ""];
    NSDictionary *arguments = @{};
    [self.webView callAsyncJavaScript:javaScript
                       arguments:arguments
                         inFrame:nil
                 inContentWorld:WKContentWorld.pageWorld
              completionHandler:^(id result, NSError *error) {
        NSError *jsonError;
        NSData *jsonData;
        if (error) {
            jsonData = [NSJSONSerialization dataWithJSONObject:@{@"error": error.localizedDescription}
                                                       options:0
                                                         error:&jsonError];
        } else {
            if (result == nil) {
                jsonData = [NSJSONSerialization dataWithJSONObject:@{@"result": [NSNull null]}
                                                           options:0
                                                             error:&jsonError];
            } else if ([NSJSONSerialization isValidJSONObject:result]) {
                jsonData = [NSJSONSerialization dataWithJSONObject:result
                                                           options:0
                                                             error:&jsonError];
            } else {
                jsonData = [NSJSONSerialization dataWithJSONObject:@{@"result": [result description]}
                                                           options:0
                                                             error:&jsonError];
            }
            if (jsonError) {
                jsonData = [NSJSONSerialization dataWithJSONObject:@{@"error": jsonError.localizedDescription}
                                                           options:0
                                                             error:&jsonError];
            }
        }
        NSString *jsonString = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
        completionHandler(messageId, webviewId, hostWebviewId, jsonString.UTF8String);
    }];
}


- (void)addPreloadScriptToWebView:(const char*)jsString {
    NSString *code = (jsString ? [NSString stringWithUTF8String:jsString] : @"");
    WKUserScript *script = [[WKUserScript alloc] initWithSource:code
                                                  injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                               forMainFrameOnly:false];
    [self.webView.configuration.userContentController addUserScript:script];    
}

- (void)updateCustomPreloadScript:(const char*)jsString {    
    WKUserContentController *contentController = self.webView.configuration.userContentController;
    NSString *identifierComment = [NSString stringWithFormat:@"// %@\n", [NSString stringWithUTF8String:"electrobun_custom_preload_script"]];
    NSString *newScriptSource = [identifierComment stringByAppendingString:[NSString stringWithUTF8String:jsString ?: ""]];
    NSMutableArray *newScripts = [NSMutableArray array];
    for (WKUserScript *userScript in contentController.userScripts) {
        if (![userScript.source containsString:identifierComment]) {
            [newScripts addObject:userScript];
        }
    }
    [contentController removeAllUserScripts];
    for (WKUserScript *userScript in newScripts) {
        [contentController addUserScript:userScript];
    }
    WKUserScript *newUserScript = [[WKUserScript alloc] initWithSource:newScriptSource
                                                          injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                       forMainFrameOnly:true];
    [contentController addUserScript:newUserScript];
}

@end

// ----------------------------------------------------------------------------
// 6) CEF AND NSAPPLICATION SETUP
// ----------------------------------------------------------------------------

// Provide the CefAppProtocol implementation
@interface ElectrobunNSApplication : NSApplication <CefAppProtocol> {
@private
  BOOL handlingSendEvent_;
}
@end

@implementation ElectrobunNSApplication
- (BOOL)isHandlingSendEvent {
  return handlingSendEvent_;
}
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {
  handlingSendEvent_ = handlingSendEvent;
}
- (void)sendEvent:(NSEvent*)event {
  CefScopedSendingEvent sendingEventScoper;
  [super sendEvent:event];
}
@end

class ElectrobunHandler : public CefClient,
                         public CefDisplayHandler,
                         public CefLifeSpanHandler,
                         public CefLoadHandler {
public:
    static ElectrobunHandler* GetInstance() {
        return g_instance;
    }
    ElectrobunHandler() {
        DCHECK(!g_instance);
        g_instance = this;
    }
    ~ElectrobunHandler() {
        g_instance = nullptr;
    }

    CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
    CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
    CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

    void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
        CEF_REQUIRE_UI_THREAD();
        browser_list_.push_back(browser);
    }
    bool DoClose(CefRefPtr<CefBrowser> browser) override {
        CEF_REQUIRE_UI_THREAD();
        if (browser_list_.size() == 1) {
            is_closing_ = true;
        }
        return false;
    }
    void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
        CEF_REQUIRE_UI_THREAD();
        for (auto bit = browser_list_.begin(); bit != browser_list_.end(); ++bit) {
            if ((*bit)->IsSame(browser)) {
                browser_list_.erase(bit);
                break;
            }
        }
        if (browser_list_.empty()) {
            CefQuitMessageLoop();
        }
    }

private:
    static ElectrobunHandler* g_instance;
    typedef std::list<CefRefPtr<CefBrowser>> BrowserList;
    BrowserList browser_list_;
    bool is_closing_ = false;

    IMPLEMENT_REFCOUNTING(ElectrobunHandler);
    DISALLOW_COPY_AND_ASSIGN(ElectrobunHandler);
};

ElectrobunHandler* ElectrobunHandler::g_instance = nullptr;

class ElectrobunApp : public CefApp,
                     public CefBrowserProcessHandler,
                     public CefRenderProcessHandler {
public:
    ElectrobunApp() {
        
    }
    void OnBeforeCommandLineProcessing(const CefString& process_type, CefRefPtr<CefCommandLine> command_line) override {
        command_line->AppendSwitch("use-mock-keychain");
        command_line->AppendSwitch("register-scheme-handler");
        // command_line->AppendSwitch("disable-power-save-blocker");
        // // note: without this webviews will be inactive until you mouse over them
        // command_line->AppendSwitch("disable-renderer-backgrounding");
        // command_line->AppendSwitch("disable-background-timer-throttling");
        
        command_line->AppendSwitchWithValue("custom-scheme", "views");        
    }
    void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {        
        registrar->AddCustomScheme("views", 
            CEF_SCHEME_OPTION_STANDARD | 
            CEF_SCHEME_OPTION_CORS_ENABLED |
            CEF_SCHEME_OPTION_SECURE | // treat it like https
            CEF_SCHEME_OPTION_CSP_BYPASSING | // allow things like crypto.subtle
            CEF_SCHEME_OPTION_FETCH_ENABLED);
            
    }
    
    CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
        return this;
    }
    CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override {        
        return this;
    }
    virtual void OnBeforeChildProcessLaunch(CefRefPtr<CefCommandLine> command_line) override {        
        std::vector<CefString> args;
        command_line->GetArguments(args);
        // for (const auto& arg : args) {
        //     NSLog(@"  Arg: %s", arg.ToString().c_str());
        // }
    }
    void OnContextInitialized() override {
        // Register the scheme handler factory after context is initialized
        CefRefPtr<CefCommandLine> command_line = CefCommandLine::GetGlobalCommandLine();
        // if (command_line.get() && command_line->HasSwitch("type")) {
        //     // Skip registration in non-browser processes
        //     return;
        // }
        
        // The actual factory registration will happen in the webview creation
        CefRegisterSchemeHandlerFactory("views", "", nullptr);
    }
    CefRefPtr<CefClient> GetDefaultClient() override {
        return ElectrobunHandler::GetInstance();
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunApp);
    DISALLOW_COPY_AND_ASSIGN(ElectrobunApp);
};


std::string GetScriptExecutionUrl(const std::string& frameUrl) {
    // List of URL schemes that should use about:blank for script execution
    static const std::vector<std::string> specialSchemes = {
        "data:",
        "blob:",
        "file:"
        // Add other schemes as needed
    };
    
    for (const auto& scheme : specialSchemes) {
        if (frameUrl.substr(0, scheme.length()) == scheme) {
            return "data://___preload.js";
        }
    }
    
    return frameUrl;
}



class ElectrobunClient : public CefClient,
                        public CefRenderHandler,
                        public CefLoadHandler {
private:
    uint32_t webview_id_;
    HandlePostMessage bun_bridge_handler_;
    HandlePostMessage webview_tag_handler_;
    struct PreloadScript {
        std::string code;
        bool mainFrameOnly;
    };
    
    PreloadScript electrobun_script_;
    PreloadScript custom_script_;  

public:
    ElectrobunClient(uint32_t webviewId,
                     HandlePostMessage bunBridgeHandler,
                     HandlePostMessage webviewTagBridgeHandler)
        : webview_id_(webviewId)
        , bun_bridge_handler_(bunBridgeHandler)
        , webview_tag_handler_(webviewTagBridgeHandler) {}

    void AddPreloadScript(const std::string& script, bool mainFrameOnly = false) {
        electrobun_script_ = {script, false};
    }

    void UpdateCustomPreloadScript(const std::string& script) {
        custom_script_ = {script, true};
    }

    virtual CefRefPtr<CefLoadHandler> GetLoadHandler() override { 
        return this; 
    }

    virtual CefRefPtr<CefRenderHandler> GetRenderHandler() override {
        return this;
    }

    // Required CefRenderHandler methods
    virtual void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect& rect) override {
        rect.x = 0;
        rect.y = 0;
        rect.width = 800;
        rect.height = 600;
    }

    virtual void OnPaint(CefRefPtr<CefBrowser> browser,
                        PaintElementType type,
                        const RectList& dirtyRects,
                        const void* buffer,
                        int width,
                        int height) override {}

    virtual void OnLoadStart(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefFrame> frame,
                           TransitionType transition_type) override {

        std::string frameUrl = frame->GetURL().ToString();
        std::string scriptUrl = GetScriptExecutionUrl(frameUrl);

        if (!electrobun_script_.code.empty() && 
            (!electrobun_script_.mainFrameOnly || frame->IsMain())) {
            frame->ExecuteJavaScript(electrobun_script_.code, scriptUrl, 0);
        }
        
        if (!custom_script_.code.empty() && 
            (!custom_script_.mainFrameOnly || frame->IsMain())) {
            frame->ExecuteJavaScript(custom_script_.code, scriptUrl, 0);
        }
    }   

    virtual bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                        CefRefPtr<CefFrame> frame,
                                        CefProcessId source_process,
                                        CefRefPtr<CefProcessMessage> message) override {
        if (message->GetName() == "BunBridgeMessage") {
            CefString msg = message->GetArgumentList()->GetString(0);
            bun_bridge_handler_(webview_id_, msg.ToString().c_str());
            return true;
        }
        else if (message->GetName() == "WebviewTagMessage") {
            CefString msg = message->GetArgumentList()->GetString(0);
            webview_tag_handler_(webview_id_, msg.ToString().c_str());
            return true;
        }
        return false;
    }

    IMPLEMENT_REFCOUNTING(ElectrobunClient);
};

// Global CEF reference
CefRefPtr<ElectrobunApp> g_app;
#include "include/cef_command_line.h"
extern "C" bool initializeCEF() {
    static bool initialized = false;
    if (initialized) return true;
    
    [ElectrobunNSApplication sharedApplication];
    if (![NSApp isKindOfClass:[ElectrobunNSApplication class]]) {        
        return false;
    }

    NSProcessInfo* processInfo = [NSProcessInfo processInfo];
    NSArray* arguments = [processInfo arguments];
    int argc = (int)[arguments count];
    char** argv = (char**)malloc(sizeof(char*) * argc);
    for (int i = 0; i < argc; i++) {
        argv[i] = strdup([[arguments objectAtIndex:i] UTF8String]);
    }
    CefMainArgs main_args(argc, argv);
    g_app = new ElectrobunApp();

    CefSettings settings;
    settings.no_sandbox = true;
    settings.log_severity = LOGSEVERITY_VERBOSE;
    
    // Add cache path to prevent warnings and potential issues
    NSString* appSupportPath = [NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES) firstObject];
    NSString* cachePath = [appSupportPath stringByAppendingPathComponent:@"Electrobun/CEF"];
    CefString(&settings.root_cache_path) = [cachePath UTF8String];
    
    // Enable network service
    // settings.packaged_services = cef_services_t::CEF_SERVICE_ALL;
    
    // Set language
    CefString(&settings.accept_language_list) = "en-US,en";

    // Register custom scheme
    // CefRegisterSchemeHandlerFactory("views", "", new ElectrobunSchemeHandlerFactory(assetFileLoader, 0));
    
    // Make CEF aware of the custom scheme
    // CefCommandLine::GetGlobalCommandLine()->AppendSwitch("register-scheme-handler");
    // CefCommandLine::GetGlobalCommandLine()->AppendSwitchWithValue("custom-scheme", "views");
    
    // Enable required packaged services
    // settings.packaged_services = cef_services_t::CEF_SERVICE_ALL;    
    
    bool result = CefInitialize(main_args, settings, g_app.get(), nullptr);

    for (int i = 0; i < argc; i++) free(argv[i]);
    free(argv);

    if (!result) {        
        return false;
    }
        
    initialized = true;
    return true;
}


//////// CEF Implementation


@interface CEFWebViewImpl : AbstractWebView
// @property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, assign) uint32_t webviewId;


- (instancetype)initWithWebviewId:(uint32_t)webviewId
                           window:(NSWindow *)window   
                           url:(const char *)url                                                
                            frame:(NSRect)frame
                  assetFileLoader:(zigStartURLSchemeTaskCallback)assetFileLoader
                       autoResize:(bool)autoResize
              partitionIdentifier:(const char *)partitionIdentifier
              navigationCallback:(DecideNavigationCallback)navigationCallback
              webviewEventHandler:(WebviewEventHandler)webviewEventHandler
              bunBridgeHandler:(HandlePostMessage)bunBridgeHandler
              webviewTagBridgeHandler:(HandlePostMessage)webviewTagBridgeHandler
              electrobunPreloadScript:(const char *)electrobunPreloadScript
              customPreloadScript:(const char *)customPreloadScript;

@end
@implementation CEFWebViewImpl {
    CefRefPtr<CefBrowser> _browser;
    CefRefPtr<ElectrobunClient> _client;
    NSView* _browserView;
    // bool _isDestroying;
}

- (instancetype)initWithWebviewId:(uint32_t)webviewId
                          window:(NSWindow *)window
                            url:(const char *)url                           
                          frame:(NSRect)frame
                assetFileLoader:(zigStartURLSchemeTaskCallback)assetFileLoader
                    autoResize:(bool)autoResize
            partitionIdentifier:(const char *)partitionIdentifier
            navigationCallback:(DecideNavigationCallback)navigationCallback
            webviewEventHandler:(WebviewEventHandler)webviewEventHandler
              bunBridgeHandler:(HandlePostMessage)bunBridgeHandler
        webviewTagBridgeHandler:(HandlePostMessage)webviewTagBridgeHandler
        electrobunPreloadScript:(const char *)electrobunPreloadScript
        customPreloadScript:(const char *)customPreloadScript
{
    self = [super init];
    if (self) {
        NSLog(@"CEFWebViewImpl init - self pointer: %p", self);
        _webviewId = webviewId;

        void (^createCEFBrowser)(void) = ^{   
             NSLog(@"Creating CEF browser - self pointer: %p", self); 
             [window makeKeyAndOrderFront:nil];
            CefBrowserSettings browserSettings;
            CefWindowInfo window_info;
            
            NSView *contentView = window.contentView;
            [contentView setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
            [contentView setAutoresizesSubviews:YES];
            
            CGFloat adjustedY = contentView.bounds.size.height - frame.origin.y - frame.size.height;
            CefRect cefBounds((int)frame.origin.x,
                            (int)adjustedY,
                            (int)frame.size.width,
                            (int)frame.size.height);
            window_info.SetAsChild((__bridge void*)contentView, cefBounds);
            
            // Register the scheme handler factory for this webview
            CefRefPtr<ElectrobunSchemeHandlerFactory> factory(
                new ElectrobunSchemeHandlerFactory(assetFileLoader, webviewId));
            
            bool registered = CefRegisterSchemeHandlerFactory("views", "", factory);            
            CefRegisterSchemeHandlerFactory("data", "", factory);            
            
            // CefRefPtr<ElectrobunClient> client(new ElectrobunClient());
            _client = new ElectrobunClient(
                webviewId,  
                bunBridgeHandler, 
                webviewTagBridgeHandler  
            );

            

            [self addPreloadScriptToWebView:electrobunPreloadScript];
            // NSLog(@"custom preload script %s", customPreloadScript);
            [self updateCustomPreloadScript:customPreloadScript];

            CefString initialUrl;
            
            // Determine if this is an internal or external URL
            if (url && url[0] != '\0') {              
                initialUrl = CefString(url);              
            } else {
                initialUrl = CefString("about:blank");                
            }

            
            
            _browser = CefBrowserHost::CreateBrowserSync(
                window_info, _client, initialUrl, browserSettings, nullptr, nullptr);

            
            
                
            // if (!browser) {
            //     NSLog(@"[CEF] Failed to create browser!");
            // } else {
            //     NSLog(@"[CEF] Browser created successfully");
            // }
            
            
        };
        
        // TODO: revisit bug with 3 windows where 2nd windows' oopifs don't get created
        // until moving the mouse and where createCEFBrowser() after async causes a crash
        NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
        NSArray *notificationNames = @[ NSWindowDidUpdateNotification ];
        __block BOOL hasCreatedBrowser = NO;
        for (NSString *notificationName in notificationNames) {
            [center addObserverForName:notificationName
                            object:window
                                queue:[NSOperationQueue mainQueue]
                        usingBlock:^(NSNotification *note) {
                
                if (!hasCreatedBrowser) {
                    hasCreatedBrowser = YES;
                    NSLog(@"-----------------> DISPATCH 2");
                    createCEFBrowser();
                    
                }
            }];
        }
        [window makeKeyAndOrderFront:nil];
        dispatch_async(dispatch_get_main_queue(), ^{               
            // createCEFBrowser();
            NSLog(@"-----------------> DISPATCH 1");
        });

  
        // dispatch_async(dispatch_get_main_queue(), ^{               
            // dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            //     createCEFBrowser();
            //     NSLog(@"-----------------> DISPATCH 1");
            // });
        // });

        
    }
    return self;
}

- (void *)nativeView {
    return (__bridge void *)_browserView;
}

- (void)loadURL:(const char *)urlString {
   
}


- (void)goBack {
   
}

- (void)goForward {
    
}

- (void)reload {
    
}

- (void)remove {
   
}

- (void)setTransparent:(BOOL)transparent {
   
}

- (void)setHidden:(BOOL)hidden {
   
}

- (void)resize:(NSRect)frame withMasksJSON:(const char *)masksJson {
   
}

- (BOOL)canGoBack {
    // TODO: actually implement
    return true;
}

- (BOOL)canGoForward {
    // TODO: actually implement
    return true;
}

- (void)evaluateJavaScriptWithNoCompletion:(const char*)jsString {
    NSLog(@"in CEF IMpl evaluateJavaScriptWithNoCompletion\n");
    if (!jsString) return;
    
    CefRefPtr<CefFrame> mainFrame = _browser->GetMainFrame();
    if (!mainFrame) {
        NSLog(@"[CEF] Failed to get main frame for JavaScript evaluation");
        return;
    }

    // Execute in the main context
    mainFrame->ExecuteJavaScript(
        CefString(jsString),
        mainFrame->GetURL(),
        0  // Line number for debugging
    );
}

- (void)evaluateJavaScriptInSecureContentWorld:(const char*)jsString {
    if (!jsString) return;
    
    CefRefPtr<CefFrame> mainFrame = _browser->GetMainFrame();
    if (!mainFrame) {
        NSLog(@"[CEF] Failed to get main frame for secure JavaScript evaluation");
        return;
    }

    // Create an isolated context by wrapping the code in an IIFE with a unique scope
    std::string isolatedCode = "(function() { \
        'use strict'; \
        const electrobunSecureWorld = {}; \
        (function(exports) { \
            " + std::string(jsString) + " \
        })(electrobunSecureWorld); \
    })();";

    mainFrame->ExecuteJavaScript(
        CefString(isolatedCode),
        mainFrame->GetURL(),
        0  // Line number for debugging
    );
}

- (void)callAsyncJavascript:(const char*)messageId 
                  jsString:(const char*)jsString 
                 webviewId:(uint32_t)webviewId 
             hostWebviewId:(uint32_t)hostWebviewId 
         completionHandler:(callAsyncJavascriptCompletionHandler)completionHandler {
   
}

- (void)addPreloadScriptToWebView:(const char*)jsString {
    if (!jsString) return;
    
    std::string script(jsString);
    
    ElectrobunClient* client = static_cast<ElectrobunClient*>(_client.get());
    client->AddPreloadScript(script);
}

- (void)updateCustomPreloadScript:(const char*)jsString {   
   if (!jsString) return;
    
    std::string script(jsString);
    
    ElectrobunClient* client = static_cast<ElectrobunClient*>(_client.get());
    client->UpdateCustomPreloadScript(script);
}

@end




// ----------------------------------------------------------------------------
// 7) "VIEWS://" SCHEMA UTILS & MISC
// ----------------------------------------------------------------------------

CGFloat OFFSCREEN_OFFSET = -20000;

extern "C" void* getNilValue() {
    return NULL;
}

extern "C" AbstractWebView* initWebview(uint32_t webviewId,
                        NSWindow *window,
                        const char *renderer,
                        const char *url,                        
                        NSRect frame,
                        zigStartURLSchemeTaskCallback assetFileLoader,
                        bool autoResize,
                        const char *partitionIdentifier,
                        DecideNavigationCallback navigationCallback,
                        WebviewEventHandler webviewEventHandler,
                        HandlePostMessage bunBridgeHandler,
                        HandlePostMessage webviewTagBridgeHandler,
                        const char *electrobunPreloadScript,
                        const char *customPreloadScript ) {


    

    AbstractWebView *impl = nil;
    
    Class ImplClass = (strcmp(renderer, "cef") == 0) ? [CEFWebViewImpl class] : [WKWebViewImpl class];

     NSLog(@"Creating webview with renderer: %s", renderer);

    impl = [[ImplClass alloc] initWithWebviewId:webviewId
                                    window:window
                                    url:url
                                    frame:frame
                                    assetFileLoader:assetFileLoader
                                    autoResize:autoResize
                                    partitionIdentifier:partitionIdentifier
                                    navigationCallback:navigationCallback
                                    webviewEventHandler:webviewEventHandler
                                    bunBridgeHandler:bunBridgeHandler
                                    webviewTagBridgeHandler:webviewTagBridgeHandler
                                    electrobunPreloadScript:electrobunPreloadScript
                                    customPreloadScript:customPreloadScript];

    NSLog(@"Created webview impl pointer: %p", impl);
    return impl;
    
}

// ----------------------------------------------------------------------------
// 9) OTHER WKWEBVIEW BRIDGING CALLS
// ----------------------------------------------------------------------------

extern "C" void loadURLInWebView(AbstractWebView *webView, const char *urlString) {
    [webView loadURL:urlString];
}

extern "C" void webviewTagGoBack(AbstractWebView *webView) {    
    [webView goBack];
}

extern "C" void webviewTagGoForward(AbstractWebView *webView) {
    [webView goForward];
}

extern "C" void webviewTagReload(AbstractWebView *webView) {
    [webView reload];
}

extern "C" void webviewRemove(AbstractWebView *webView) {    
    [webView remove];
}

extern "C" BOOL webviewCanGoBack(AbstractWebView *webView) {    
    return [webView canGoBack];
}

extern "C" BOOL webviewCanGoForward(AbstractWebView *webView) {    
    return [webView canGoForward];
}

extern "C" void evaluateJavaScriptWithNoCompletion(AbstractWebView *webView, const char *script) {    
    NSLog(@"evaluateJavaScriptWithNoCompletion in objc \n");
    [webView evaluateJavaScriptWithNoCompletion:script];    
}

// wkWebkit
// Memory contents - first 4 words:
// bun:  2025-01-28 16:53:20.926 webview[1421:5734524]   Offset 0: 10000010250b0a9
// bun:  2025-01-28 16:53:20.926 webview[1421:5734524]   Offset 8: 3
// bun:  2025-01-28 16:53:20.926 webview[1421:5734524]   Offset 16: 10400621180
// bun:  2025-01-28 16:53:20.926 webview[1421:5734524]   Offset 24: 0
// bun:  2025-01-28 16:53:20.926 webview[1421:5734524] Object appears to be of class: WKWebViewImpl

// CEF
// Memory contents - first 4 words:
// bun:  2025-01-28 16:54:29.507 webview[1714:5737358]   Offset 0: 1000001044fb149
// bun:  2025-01-28 16:54:29.507 webview[1714:5737358]   Offset 8: 0
// bun:  2025-01-28 16:54:29.507 webview[1714:5737358]   Offset 16: 0
// bun:  2025-01-28 16:54:29.507 webview[1714:5737358]   Offset 24: 11401449d80
// bun:  2025-01-28 16:54:29.507 webview[1714:5737358] Object appears to be of class: CEFWebViewImpl
extern "C" void testFFI(void *ptr) {              
    NSLog(@"ObjC side - raw ptr: %p", ptr);
    
    // Dump memory contents
    uintptr_t *memory = (uintptr_t *)ptr;
    NSLog(@"Memory contents - first 4 words:");
    for(int i = 0; i < 4; i++) {
        NSLog(@"  Offset %d: %lx", i * 8, memory[i]);
    }
    
    // Try to get object type information
    Class cls = object_getClass((__bridge id)ptr);
    if (cls) {
        NSLog(@"Object appears to be of class: %@", cls);
    } else {
        NSLog(@"Not a valid Objective-C class pointer");
    }
    
    // Try to check vtable if it's a C++ object
    void **vtable = *(void***)ptr;
    NSLog(@"Possible vtable pointer: %p", vtable);
}

extern "C" void evaluateJavaScriptinSecureContentWorld(AbstractWebView *webView, const char *jsString) {    
    [webView evaluateJavaScriptInSecureContentWorld:jsString];    
}

// typedef void (*callAsyncJavascriptCompletionHandler)(const char *messageId, uint32_t webviewId, uint32_t hostWebviewId, const char *responseJSON);

extern "C" void callAsyncJavaScript(const char *messageId,
                                    AbstractWebView *abstractView,
                                    const char *jsString,
                                    uint32_t webviewId,
                                    uint32_t hostWebviewId,
                                    callAsyncJavascriptCompletionHandler completionHandler) {

    
   [abstractView callAsyncJavascript:messageId
                        jsString:jsString
                       webviewId:webviewId
                  hostWebviewId:hostWebviewId
               completionHandler:completionHandler];
}

extern "C" void addPreloadScriptToWebView(AbstractWebView *webView, const char *scriptContent, BOOL forMainFrameOnly) {            
    NSLog(@"+++++++++ 11111 addPreloadScriptToWebView %s", "hi");
    [webView addPreloadScriptToWebView:scriptContent];    
}

// todo: remove identifier and add option forMainFrameOnly
extern "C" void updatePreloadScriptToWebView(AbstractWebView *webView,
                                             const char *scriptIdentifier,
                                             const char *scriptContent,
                                             BOOL forMainFrameOnly) {
    [webView updateCustomPreloadScript:scriptContent];    
}


// ----------------------------------------------------------------------------
// 11) GET NAVIGATION ACTION / MESSAGE BODIES
// ----------------------------------------------------------------------------

extern "C" void invokeDecisionHandler(void (^decisionHandler)(WKNavigationActionPolicy), WKNavigationActionPolicy policy) {
    if (decisionHandler) {
        decisionHandler(policy);
    }
}

extern "C" const char* getUrlFromNavigationAction(WKNavigationAction *navigationAction) {
    NSURLRequest *request = navigationAction.request;
    NSURL *url = request.URL;
    return url.absoluteString.UTF8String;
}

extern "C" const char* getBodyFromScriptMessage(WKScriptMessage *message) {
    NSString *body = message.body;
    return body.UTF8String;
}

// ----------------------------------------------------------------------------
// 12) TRANSPARENT WEBVIEW VISIBILITY UTILS
// ----------------------------------------------------------------------------

extern "C" void webviewTagSetTransparent(AbstractWebView *webview, BOOL transparent) {
    
        [webview setTransparent:transparent];
    
}

extern "C" void webviewTagToggleMirroring(AbstractWebView *webview, BOOL enable) {
   
        [webview toggleMirroring:enable];
    
}

extern "C" void webviewTagSetPassthrough(AbstractWebView *webview, BOOL enablePassthrough) {
    
        [webview setPassthrough:enablePassthrough];
    
}

extern "C" void webviewSetHidden(AbstractWebView *webview, BOOL hidden) {
   
        [webview setHidden:hidden];
    
}

// ----------------------------------------------------------------------------
// 13) WINDOW & CONTAINER LOGIC
// ----------------------------------------------------------------------------

NSUInteger getNSWindowStyleMask(WindowStyleMaskOptions options) {
    NSUInteger mask = 0;
    if (options.Borderless) mask |= NSWindowStyleMaskBorderless;
    if (options.Titled) mask |= NSWindowStyleMaskTitled;
    if (options.Closable) mask |= NSWindowStyleMaskClosable;
    if (options.Miniaturizable) mask |= NSWindowStyleMaskMiniaturizable;
    if (options.Resizable) mask |= NSWindowStyleMaskResizable;
    if (options.UnifiedTitleAndToolbar) mask |= NSWindowStyleMaskUnifiedTitleAndToolbar;
    if (options.FullScreen) mask |= NSWindowStyleMaskFullScreen;
    if (options.FullSizeContentView) mask |= NSWindowStyleMaskFullSizeContentView;
    if (options.UtilityWindow) mask |= NSWindowStyleMaskUtilityWindow;
    if (options.DocModalWindow) mask |= NSWindowStyleMaskDocModalWindow;
    if (options.NonactivatingPanel) mask |= NSWindowStyleMaskNonactivatingPanel;
    if (options.HUDWindow) mask |= NSWindowStyleMaskHUDWindow;
    return mask;
}

extern "C" NSRect createNSRectWrapper(double x, double y, double width, double height) {
    return NSMakeRect(x, y, width, height);
}

@interface AppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation AppDelegate
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {    
    return NSTerminateNow;
}
@end

extern "C" void runNSApplication() {    
    if (useCEF) {
        @autoreleasepool {
            if (!initializeCEF()) {                
                return;
            }
            NSApplication *app = [NSApplication sharedApplication];
            AppDelegate *delegate = [[AppDelegate alloc] init];
            [app setDelegate:delegate];
            retainObjCObject(delegate);

            [NSApp finishLaunching];
            CefRunMessageLoop();
            CefShutdown();
        }
    } else {
        NSApplication *app = [NSApplication sharedApplication];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        [app setDelegate:delegate];
        retainObjCObject(delegate);
        [app run];
    }
}


@interface WindowDelegate : NSObject <NSWindowDelegate>
@property (nonatomic, assign) WindowCloseHandler closeHandler;
@property (nonatomic, assign) WindowMoveHandler moveHandler;
@property (nonatomic, assign) WindowResizeHandler resizeHandler;
@property (nonatomic, assign) uint32_t windowId;
@property (nonatomic, strong) NSWindow *window;
@end

@implementation WindowDelegate
- (BOOL)windowShouldClose:(NSWindow *)sender {
   return YES;
}
- (void)windowWillClose:(NSNotification *)notification {
    NSWindow *window = [notification object];
    if (self.closeHandler) {
        self.closeHandler(self.windowId);
    }
}
- (void)windowDidResize:(NSNotification *)notification {
    NSWindow *window = [notification object];
    NSRect windowFrame = [window frame];
    NSView *contentView = [window contentView];
    NSRect fullFrame = [window frame];
    fullFrame.origin.x = 0;
    fullFrame.origin.y = 0;

    // Note: wkwebview opens devtools attached by default. Nothing we've tried stops that
    // The compromise for now is to not crash, let users "pop out" devtools and from then on
    // it'll pop out for them by default.
    for (NSView *subview in contentView.subviews) {
        if (![subview isKindOfClass:[TransparentWKWebView class]]) {
            continue;
        }
            
        TransparentWKWebView *webView = (TransparentWKWebView *)subview;
        if (webView.fullSize) {
            // extern void resizeWebview(TransparentWKWebView *view, NSRect frame, const char *masksJson);
            // resizeWebview(webView, fullFrame, "");
            [webView.abstractView resize:fullFrame withMasksJSON:""];
        }
        
    }
    if (self.resizeHandler) {
        NSScreen *primaryScreen = [NSScreen screens][0];
        NSRect screenFrame = [primaryScreen frame];
        windowFrame.origin.y = screenFrame.size.height - windowFrame.origin.y - windowFrame.size.height;
        self.resizeHandler(self.windowId, windowFrame.origin.x, windowFrame.origin.y,
                           windowFrame.size.width, windowFrame.size.height);
    }
}
- (void)windowDidMove:(NSNotification *)notification {
    if (self.moveHandler) {
        NSWindow *window = [notification object];
        NSRect windowFrame = [window frame];
        NSScreen *primaryScreen = [NSScreen screens][0];
        NSRect screenFrame = [primaryScreen frame];
        windowFrame.origin.y = screenFrame.size.height - windowFrame.origin.y - windowFrame.size.height;
        self.moveHandler(self.windowId, windowFrame.origin.x, windowFrame.origin.y);
    }
}
@end

typedef struct {
    NSRect frame;
    WindowStyleMaskOptions styleMask;
    const char *titleBarStyle;
} createNSWindowWithFrameAndStyleParams;

extern "C" NSWindow *createNSWindowWithFrameAndStyle(uint32_t windowId,
                                                     createNSWindowWithFrameAndStyleParams config,
                                                     WindowCloseHandler zigCloseHandler,
                                                     WindowMoveHandler zigMoveHandler,
                                                     WindowResizeHandler zigResizeHandler) {
    NSScreen *primaryScreen = [NSScreen screens][0];
    NSRect screenFrame = [primaryScreen frame];
    config.frame.origin.y = screenFrame.size.height - config.frame.origin.y;

    NSWindow *window = [[NSWindow alloc] initWithContentRect:config.frame
                                                   styleMask:getNSWindowStyleMask(config.styleMask)
                                                     backing:NSBackingStoreBuffered
                                                       defer:YES
                                                      screen:primaryScreen];
    [window setFrameTopLeftPoint:config.frame.origin];
    if (strcmp(config.titleBarStyle, "hiddenInset") == 0) {
        window.titlebarAppearsTransparent = YES;
        window.titleVisibility = NSWindowTitleHidden;
    }
    WindowDelegate *delegate = [[WindowDelegate alloc] init];
    delegate.closeHandler = zigCloseHandler;
    delegate.resizeHandler = zigResizeHandler;
    delegate.moveHandler = zigMoveHandler;
    delegate.windowId = windowId;
    delegate.window = window;
    [window setDelegate:delegate];
    objc_setAssociatedObject(window, "WindowDelegate", delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    window.releasedWhenClosed = NO;

    ContainerView *contentView = [[ContainerView alloc] initWithFrame:[window frame]];
    contentView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window setContentView:contentView];
    return window;
}

extern "C" void makeNSWindowKeyAndOrderFront(NSWindow *window) {
    [window makeKeyAndOrderFront:nil];
}

extern "C" void setNSWindowTitle(NSWindow *window, const char *title) {
    NSString *titleString = [NSString stringWithUTF8String:title ?: ""];
    [window setTitle:titleString];
}

extern "C" void closeNSWindow(NSWindow *window) {
    [window close];
}


extern "C" void resizeWebview(AbstractWebView *webView, NSRect frame, const char *masksJson) {
    [webView resize:frame withMasksJSON:masksJson];
    
}

// ----------------------------------------------------------------------------
// 15) WINDOW DRAGGING
// ----------------------------------------------------------------------------

static BOOL isMovingWindow = NO;
static NSWindow *targetWindow = nil;
static CGFloat offsetX = 0.0;
static CGFloat offsetY = 0.0;
static id mouseDraggedMonitor = nil;
static id mouseUpMonitor = nil;

extern "C" void stopWindowMove() {
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

extern "C" void startWindowMove(NSWindow *window) {
    targetWindow = window;
    if (!targetWindow) {
        NSLog(@"No window found for the given WebView.");
        return;
    }
    isMovingWindow = YES;
    NSPoint initialLocation = [NSEvent mouseLocation];

    mouseDraggedMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseDragged | NSEventMaskMouseMoved)
                                                                handler:^NSEvent *(NSEvent *event) {
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
    mouseUpMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseUp
                                                           handler:^NSEvent *(NSEvent *event) {
        if (isMovingWindow) {
            stopWindowMove();
        }
        return event;
    }];
}

// ----------------------------------------------------------------------------
// 16) FILESYSTEM UTILS
// ----------------------------------------------------------------------------

extern "C" BOOL moveToTrash(char *pathString) {
    NSString *path = [NSString stringWithUTF8String:pathString ?: ""];
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

extern "C" void showItemInFolder(char *path) {
    NSString *pathString = [NSString stringWithUTF8String:path ?: ""];
    NSURL *fileURL = [NSURL fileURLWithPath:pathString];
    [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[fileURL]];
}

extern "C" const char *openFileDialog(const char *startingFolder,
                                      const char *allowedFileTypes,
                                      BOOL canChooseFiles,
                                      BOOL canChooseDirectories,
                                      BOOL allowsMultipleSelection) {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    [panel setCanChooseFiles:canChooseFiles];
    [panel setCanChooseDirectories:canChooseDirectories];
    [panel setAllowsMultipleSelection:allowsMultipleSelection];

    NSString *startFolder = [NSString stringWithUTF8String:startingFolder ?: ""];
    [panel setDirectoryURL:[NSURL fileURLWithPath:startFolder]];
    if (allowedFileTypes && strcmp(allowedFileTypes, "*") != 0 && strcmp(allowedFileTypes, "") != 0) {
        NSString *allowedTypesStr = [NSString stringWithUTF8String:allowedFileTypes];
        NSArray *fileTypesArray = [allowedTypesStr componentsSeparatedByString:@","];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        [panel setAllowedFileTypes:fileTypesArray];
#pragma clang diagnostic pop
    }
    NSInteger result = [panel runModal];
    if (result == NSModalResponseOK) {
        NSArray<NSURL *> *selectedFileURLs = [panel URLs];
        NSMutableArray<NSString *> *pathStrings = [NSMutableArray array];
        for (NSURL *u in selectedFileURLs) {
            [pathStrings addObject:u.path];
        }
        NSString *concatenatedPaths = [pathStrings componentsJoinedByString:@","];
        return strdup([concatenatedPaths UTF8String]);
    }
    return NULL;
}

// ----------------------------------------------------------------------------
// 17) SNAPSHOT
// ----------------------------------------------------------------------------

extern "C" void getWebviewSnapshot(uint32_t hostId, uint32_t webviewId,
                                   WKWebView *webView,
                                   zigSnapshotCallback callback) {
    WKSnapshotConfiguration *snapshotConfig = [[WKSnapshotConfiguration alloc] init];
    [webView takeSnapshotWithConfiguration:snapshotConfig completionHandler:^(NSImage *snapshotImage, NSError *error) {
        if (error) {
            NSLog(@"Error capturing snapshot: %@", error);
            return;
        }
        NSBitmapImageRep *imgRep = [[NSBitmapImageRep alloc] initWithData:[snapshotImage TIFFRepresentation]];
        NSData *pngData = [imgRep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        NSString *base64String = [pngData base64EncodedStringWithOptions:0];
        NSString *dataUrl = [NSString stringWithFormat:@"data:image/png;base64,%@", base64String];
        if (callback) {
            callback(hostId, webviewId, [dataUrl UTF8String]);
        }
    }];
}





// ----------------------------------------------------------------------------
// 20) APP AND CONTEXT MENUS
// ----------------------------------------------------------------------------

extern "C" void shutdownApplication() {
    CefShutdown();
}

typedef struct {
    // Could add fields if needed
} MenuItemConfig;

@interface StatusItemTarget : NSObject
@property (nonatomic, assign) NSStatusItem *statusItem;
@property (nonatomic, assign) ZigStatusItemHandler zigHandler;
@property (nonatomic, assign) uint32_t trayId;
- (void)statusItemClicked:(id)sender;
- (void)menuItemClicked:(id)sender;
@end

@implementation StatusItemTarget
- (void)statusItemClicked:(id)sender {
    if (self.zigHandler) {
        self.zigHandler(self.trayId, "");
    }
}
- (void)menuItemClicked:(id)sender {
    NSMenuItem *menuItem = (NSMenuItem *)sender;
    NSString *action = menuItem.representedObject;
    if (!action) {
        NSLog(@"No action found for menu item");
        return;
    }
    if (!self.zigHandler) {
        NSLog(@"No zig handler found for menu item");
        return;
    }
    self.zigHandler(self.trayId, [action UTF8String]);
}
@end

extern "C" NSStatusItem* createTray(uint32_t trayId, const char *title, const char *pathToImage, bool isTemplate,
                                    uint32_t width, uint32_t height, ZigStatusItemHandler zigTrayItemHandler) {
    NSString *pathToImageString = [NSString stringWithUTF8String:pathToImage ?: ""];
    NSString *titleString = [NSString stringWithUTF8String:title ?: ""];
    NSStatusItem *statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];

    if (pathToImageString.length > 0) {
        statusItem.button.image = [[NSImage alloc] initWithContentsOfFile:pathToImageString];
        [statusItem.button.image setTemplate:isTemplate];
        statusItem.button.image.size = NSMakeSize(width, height);
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
        [statusItem.button sendActionOn:(NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp)];
    }
    retainObjCObject(statusItem);
    return statusItem;
}

extern "C" void setTrayTitle(NSStatusItem *statusItem, const char *title) {
    if (statusItem) {
        statusItem.button.title = [NSString stringWithUTF8String:title ?: ""];
    }
}

extern "C" void setTrayImage(NSStatusItem *statusItem, const char *image) {
    if (statusItem) {
        NSString *imgPath = [NSString stringWithUTF8String:image ?: ""];
        statusItem.button.image = [[NSImage alloc] initWithContentsOfFile:imgPath];
    }
}

NSMenu *createMenuFromConfig(NSArray *menuConfig, StatusItemTarget *target) {
    NSMenu *menu = [[NSMenu alloc] init];
    [menu setAutoenablesItems:NO];

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
            menuItem = [[NSMenuItem alloc] initWithTitle:label ?: @""
                                                  action:@selector(menuItemClicked:)
                                           keyEquivalent:@""];
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
                        menuItem.keyEquivalent = [NSString stringWithFormat:@"%c",(char)NSDeleteCharacter];
                        menuItem.keyEquivalentModifierMask = 0;
                    } else if ([role isEqualToString:@"selectAll"]) {
                        menuItem.keyEquivalent = @"a";
                        menuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand;
                    }
                }
            } else {
                menuItem.target = target;
            }
            if (accelerator) {
                menuItem.keyEquivalent = accelerator;
                if (modifierMask) {
                    menuItem.keyEquivalentModifierMask = [modifierMask unsignedIntegerValue];
                } else {
                    menuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand;
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

extern "C" void setTrayMenuFromJSON(NSStatusItem *statusItem, const char *jsonString) {
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

extern "C" void setTrayMenu(NSStatusItem *statusItem, const char *menuConfig) {
    if (statusItem) {
        setTrayMenuFromJSON(statusItem, menuConfig);
    }
}

extern "C" void setApplicationMenu(const char *jsonString, ZigStatusItemHandler zigTrayItemHandler) {
    NSLog(@"Setting application menu from JSON in objc");
    NSData *jsonData = [NSData dataWithBytes:jsonString length:strlen(jsonString)];
    NSError *error;
    NSArray *menuArray = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&error];
    if (error) {
        NSLog(@"Failed to parse JSON: %@", error);
        return;
    }
    StatusItemTarget *target = [[StatusItemTarget alloc] init];
    target.zigHandler = zigTrayItemHandler;
    target.trayId = 0;
    NSMenu *menu = createMenuFromConfig(menuArray, target);
    objc_setAssociatedObject(NSApp, "AppMenuTarget", target, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [NSApp setMainMenu:menu];
}

extern "C" void showContextMenu(const char *jsonString, ZigStatusItemHandler contextMenuHandler) {
    NSData *jsonData = [NSData dataWithBytes:jsonString length:strlen(jsonString)];
    NSError *error;
    NSArray *menuArray = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&error];
    if (error) {
        NSLog(@"Failed to parse JSON: %@", error);
        return;
    }
    StatusItemTarget *target = [[StatusItemTarget alloc] init];
    target.zigHandler = contextMenuHandler;
    target.trayId = 0;
    NSMenu *menu = createMenuFromConfig(menuArray, target);
    objc_setAssociatedObject(menu, "ContextMenuTarget", target, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

    NSPoint mouseLocation = [NSEvent mouseLocation];
    NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeRightMouseUp
                                        location:mouseLocation
                                   modifierFlags:0
                                       timestamp:0
                                    windowNumber:0
                                         context:nil
                                     eventNumber:0
                                      clickCount:1
                                        pressure:1];
    [menu popUpMenuPositioningItem:nil atLocation:mouseLocation inView:nil];
    objc_setAssociatedObject(NSApp, "ContextMenu", target, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

