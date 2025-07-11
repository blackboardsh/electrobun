/*
 * =============================================================================
 * 1. IMPORTS
 * =============================================================================
 */

#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <Cocoa/Cocoa.h>
#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonCrypto.h>
#import <QuartzCore/QuartzCore.h>

// CEF includes
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
#include "include/cef_request_handler.h" 
#include "include/cef_scheme.h"
#include "include/cef_resource_handler.h"
#include "include/cef_command_line.h"
#include <string>
#include <vector>
#include <list>
#include <cstdint>

/*
 * =============================================================================
 * 2. CONSTANTS, GLOBAL VARIABLES, FORWARD DECLARATIONS & TYPE DEFINITIONS
 * =============================================================================
 */

CGFloat OFFSCREEN_OFFSET = -20000;
BOOL useCEF = false;

static BOOL isMovingWindow = NO;
static NSWindow *targetWindow = nil;
static CGFloat offsetX = 0.0;
static CGFloat offsetY = 0.0;
static id mouseDraggedMonitor = nil;
static id mouseUpMonitor = nil;


// Forward declare the CEF classes
class CefApp;
class CefClient;
class CefLifeSpanHandler;
class CefBrowser;
class ElectrobunSchemeHandler;
class ElectrobunSchemeHandlerFactory;

// Type definitions

/** Generic bridging callback types. */
// typedef BOOL (*DecideNavigationCallback)(uint32_t webviewId, const char* url);
// NOTE: Bun's FFIType.true doesn't play well with objective C's YES/NO char booleans
// so when sending booleans from JSCallbacks we have to use u32 for now
typedef uint32_t (*DecideNavigationCallback)(uint32_t webviewId, const char* url);
typedef void (*WebviewEventHandler)(uint32_t webviewId, const char* type, const char* url);
typedef BOOL (*HandlePostMessage)(uint32_t webviewId, const char* message);
typedef const char* (*HandlePostMessageWithReply)(uint32_t webviewId, const char* message);
typedef void (*callAsyncJavascriptCompletionHandler)(const char *messageId, uint32_t webviewId, uint32_t hostWebviewId, const char *responseJSON);

// JS Utils
typedef const char* (*GetMimeType)(const char* filePath);
typedef const char* (*GetHTMLForWebviewSync)(uint32_t webviewId);
// typedef uint32_t (*GetResponseLength)(uint32_t responseId);

typedef struct {    
    GetMimeType getMimeType;
    GetHTMLForWebviewSync getHTMLForWebviewSync;    
} JSUtils;

static dispatch_queue_t jsWorkerQueue = NULL;

// Global instance of the struct
static JSUtils jsUtils = {NULL, NULL};

// this lets you call non-threadsafe JSCallbacks on the bun worker thread, from the main thread
// and wait for the response. 
// use it like:
// myCStringVal = callJsCallbackFromMainSync(^{return jsUtils.getHTMLForWebviewSync(self.webviewId);});
static const char* callJsCallbackFromMainSync(const char* (^callback)(void)) {
    if (!jsWorkerQueue) {
        NSLog(@"Error: JS worker queue not initialized");
        return NULL;
    }
    
    __block const char* result = NULL;
    __block char* resultCopy = NULL;
    
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    dispatch_async(jsWorkerQueue, ^{
        // Call the provided block (which executes the JS callback)
        result = callback();
        
        // Duplicate the result so it won’t be garbage collected.
        if (result != NULL) {
            resultCopy = strdup(result);
        }
        
        dispatch_semaphore_signal(semaphore);
    });
    
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
    return resultCopy; // Caller is responsible for freeing this memory.
}

typedef struct {
    NSRect frame;
    uint32_t styleMask;
    const char *titleBarStyle;
} createNSWindowWithFrameAndStyleParams;

/** Window event callbacks. */
// typedef void (*WindowCloseHandler)(uint32_t windowId);
// typedef void (*WindowMoveHandler)(uint32_t windowId, CGFloat x, CGFloat y);
// typedef void (*WindowResizeHandler)(uint32_t windowId, CGFloat x, CGFloat y, CGFloat width, CGFloat height);
typedef void (*WindowCloseHandler)(uint32_t windowId);
typedef void (*WindowMoveHandler)(uint32_t windowId, double x, double y);
typedef void (*WindowResizeHandler)(uint32_t windowId, double x, double y, double width, double height);


/** Tray and menu bridging. */
typedef void (*ZigStatusItemHandler)(uint32_t trayId, const char *action);
typedef void (*MenuHandler)(const char *menuItemId);

/** Snapshot callback. */
typedef void (*zigSnapshotCallback)(uint32_t hostId, uint32_t webviewId, const char * dataUrl);

typedef struct {    
} MenuItemConfig;


/*
 * =============================================================================
 * 3. UTILITY FUNCTIONS
 * =============================================================================
 */


bool isCEFAvailable() {
    NSBundle *mainBundle = [NSBundle mainBundle];
    NSString *frameworkPath = [mainBundle.privateFrameworksPath 
                              stringByAppendingPathComponent:@"Chromium Embedded Framework.framework/Chromium Embedded Framework"];
    return [[NSFileManager defaultManager] fileExistsAtPath:frameworkPath];
}

extern "C" uint32_t getNSWindowStyleMask(
    bool Borderless,
    bool Titled,
    bool Closable,
    bool Miniaturizable,
    bool Resizable,
    bool UnifiedTitleAndToolbar,
    bool FullScreen,
    bool FullSizeContentView,
    bool UtilityWindow,
    bool DocModalWindow,
    bool NonactivatingPanel,
    bool HUDWindow
) {
    uint32_t mask = 0;
    if (Borderless) mask |= NSWindowStyleMaskBorderless;
    if (Titled) mask |= NSWindowStyleMaskTitled;
    if (Closable) mask |= NSWindowStyleMaskClosable;
    if (Miniaturizable) mask |= NSWindowStyleMaskMiniaturizable;
    if (Resizable) mask |= NSWindowStyleMaskResizable;
    if (UnifiedTitleAndToolbar) mask |= NSWindowStyleMaskUnifiedTitleAndToolbar;
    if (FullScreen) mask |= NSWindowStyleMaskFullScreen;
    if (FullSizeContentView) mask |= NSWindowStyleMaskFullSizeContentView;
    if (UtilityWindow) mask |= NSWindowStyleMaskUtilityWindow;
    if (DocModalWindow) mask |= NSWindowStyleMaskDocModalWindow;
    if (NonactivatingPanel) mask |= NSWindowStyleMaskNonactivatingPanel;
    if (HUDWindow) mask |= NSWindowStyleMaskHUDWindow;
    return mask;
}

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

NSData* readViewsFile(const char* viewsUrl) {
    if (!viewsUrl) return nil;
    
    NSString *urlString = [NSString stringWithUTF8String:viewsUrl];
    
    // Check if it's a views:// URL
    if (![urlString hasPrefix:@"views://"]) {
        return nil;
    }
    
    // Remove the "views://" prefix
    NSString *relativePath = [urlString substringFromIndex:8]; // "views://" is 8 chars    
    
    // Get the views directory
    NSString *cwd = [[NSFileManager defaultManager] currentDirectoryPath];
    NSString *viewsDir = [cwd stringByAppendingPathComponent:@"../Resources/app/views"];
    NSString *filePath = [viewsDir stringByAppendingPathComponent:relativePath];    
    
    // Read the file
    return [NSData dataWithContentsOfFile:filePath];
}


// Convenience functions for manual memory management
void retainObjCObject(id objcObject) {
    CFRetain((__bridge CFTypeRef)objcObject);
}
void releaseObjCObject(id objcObject) {
    CFRelease((__bridge CFTypeRef)objcObject);
}

/*
 * =============================================================================
 * 4. OBJECTIVE-C @INTERFACES
 * =============================================================================
 */

// ----------------------- Abstract Base Classes -----------------------

@interface AbstractView : NSObject
    @property (nonatomic, assign) uint32_t webviewId;
    @property (nonatomic, assign) NSView * nsView;
    @property (nonatomic, assign) BOOL isMousePassthroughEnabled;
    @property (nonatomic, assign) BOOL mirrorModeEnabled;
    @property (nonatomic, assign) BOOL fullSize;

    - (void)loadURL:(const char *)urlString;
    - (void)goBack;
    - (void)goForward;
    - (void)reload;
    - (void)remove;

    - (void)setTransparent:(BOOL)transparent;
    - (void)setPassthrough:(BOOL)enable;
    - (void)setHidden:(BOOL)hidden;

    - (BOOL)canGoBack;
    - (BOOL)canGoForward;

    - (void)evaluateJavaScriptWithNoCompletion:(const char*)jsString;
    - (void)callAsyncJavascript:(const char*)messageId 
                       jsString:(const char*)jsString 
                      webviewId:(uint32_t)webviewId 
                  hostWebviewId:(uint32_t)hostWebviewId 
              completionHandler:(callAsyncJavascriptCompletionHandler)completionHandler;
    - (void)addPreloadScriptToWebView:(const char*)jsString;
    - (void)updateCustomPreloadScript:(const char*)jsString;

    - (void)resize:(NSRect)frame withMasksJSON:(const char *)masksJson;
@end

@interface ContainerView : NSView
    /// An reverse ordered array of abstractViews (newest first)
    @property (nonatomic, strong) NSMutableArray<AbstractView *> *abstractViews;
    - (void)addAbstractView:(AbstractView *)webview;
    - (void)removeAbstractViewWithId:(uint32_t)webviewId;
    - (void)updateActiveWebviewForMousePosition:(NSPoint)mouseLocation;
@end

// ----------------------- URL Scheme & Navigation -----------------------

@interface MyURLSchemeHandler : NSObject <WKURLSchemeHandler>    
    @property (nonatomic, assign) uint32_t webviewId;
@end

@interface MyNavigationDelegate : NSObject <WKNavigationDelegate>
    @property (nonatomic, assign) DecideNavigationCallback zigCallback;
    @property (nonatomic, assign) WebviewEventHandler zigEventHandler;
    @property (nonatomic, assign) uint32_t webviewId;
@end

@interface MyWebViewUIDelegate : NSObject <WKUIDelegate>
    @property (nonatomic, assign) WebviewEventHandler zigEventHandler;
    @property (nonatomic, assign) uint32_t webviewId;
@end

@interface MyScriptMessageHandler : NSObject <WKScriptMessageHandler>
    @property (nonatomic, assign) HandlePostMessage zigCallback;
    @property (nonatomic, assign) uint32_t webviewId;
@end

@interface MyScriptMessageHandlerWithReply : NSObject <WKScriptMessageHandlerWithReply>
    @property (nonatomic, assign) HandlePostMessageWithReply zigCallback;
    @property (nonatomic, assign) uint32_t webviewId;
@end

// ----------------------- Webview Implementations -----------------------
@interface WKWebViewImpl : AbstractView
    @property (nonatomic, strong) WKWebView *webView;

    - (instancetype)initWithWebviewId:(uint32_t)webviewId
                            window:(NSWindow *)window   
                            url:(const char *)url                                                
                                frame:(NSRect)frame                    
                        autoResize:(bool)autoResize
                partitionIdentifier:(const char *)partitionIdentifier
                navigationCallback:(DecideNavigationCallback)navigationCallback
                webviewEventHandler:(WebviewEventHandler)webviewEventHandler
                bunBridgeHandler:(HandlePostMessage)bunBridgeHandler
                internalBridgeHandler:(HandlePostMessage)internalBridgeHandler
                electrobunPreloadScript:(const char *)electrobunPreloadScript
                customPreloadScript:(const char *)customPreloadScript;
@end



// ----------------------- Application & Window Delegates -----------------------

@interface ElectrobunNSApplication : NSApplication <CefAppProtocol> {
    @private
    BOOL handlingSendEvent_;
    }
@end

@interface AppDelegate : NSObject <NSApplicationDelegate>
@end

@interface WindowDelegate : NSObject <NSWindowDelegate>
    @property (nonatomic, assign) WindowCloseHandler closeHandler;
    @property (nonatomic, assign) WindowMoveHandler moveHandler;
    @property (nonatomic, assign) WindowResizeHandler resizeHandler;
    @property (nonatomic, assign) uint32_t windowId;
    @property (nonatomic, strong) NSWindow *window;
@end

@interface StatusItemTarget : NSObject
    @property (nonatomic, assign) NSStatusItem *statusItem;
    @property (nonatomic, assign) ZigStatusItemHandler zigHandler;
    @property (nonatomic, assign) uint32_t trayId;
    - (void)statusItemClicked:(id)sender;
    - (void)menuItemClicked:(id)sender;
@end


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

/*
 * =============================================================================
 * 5. OBJECTIVE-C @IMPLEMENTATIONS
 * =============================================================================
 */

// ----------------------- AbstractView & ContainerView -----------------------
// Todo: incorporate into AbstractView
NSArray<NSValue *> *addOverlapRects(NSArray<NSDictionary *> *rectsArray, CGFloat containerHeight) {
    NSMutableArray<NSValue *> *resultingRects = [NSMutableArray array];
    for (NSDictionary *rectDict in rectsArray) {
        CGFloat x = [rectDict[@"x"] floatValue];
        CGFloat y = [rectDict[@"y"] floatValue];
        CGFloat w = [rectDict[@"width"] floatValue];
        CGFloat h = [rectDict[@"height"] floatValue];
                
        // Note: CEF does not flip the view geometry so the measured y from the dom (origin top)
        // needs to be inverted to work with MacOs default (y origin bottom) 
        if (containerHeight > 0) {
            y = containerHeight - h - y;
        }

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

@implementation AbstractView

    - (void)loadURL:(const char *)urlString { [self doesNotRecognizeSelector:_cmd]; }
    - (void)goBack { [self doesNotRecognizeSelector:_cmd]; }
    - (void)goForward { [self doesNotRecognizeSelector:_cmd]; }
    - (void)reload { [self doesNotRecognizeSelector:_cmd]; }
    - (void)remove { [self doesNotRecognizeSelector:_cmd]; }


    - (BOOL)canGoBack { [self doesNotRecognizeSelector:_cmd]; return NO; }
    - (BOOL)canGoForward { [self doesNotRecognizeSelector:_cmd]; return NO; }

    - (void)evaluateJavaScriptWithNoCompletion:(const char*)jsString { [self doesNotRecognizeSelector:_cmd]; }
    - (void)callAsyncJavascript:(const char*)messageId jsString:(const char*)jsString webviewId:(uint32_t)webviewId hostWebviewId:(uint32_t)hostWebviewId completionHandler:(callAsyncJavascriptCompletionHandler)completionHandler { [self doesNotRecognizeSelector:_cmd]; }
    // todo: we don't need this to be public since it's only used to set the internal electrobun preview script
    - (void)addPreloadScriptToWebView:(const char*)jsString { [self doesNotRecognizeSelector:_cmd]; }
    - (void)updateCustomPreloadScript:(const char*)jsString { [self doesNotRecognizeSelector:_cmd]; }

    // todo: rename to toggleOffscreen / isOffscreen
    // then create isInteractive that returns !isOffscreen && isPassthrough


    - (void)setHidden:(BOOL)hidden {
        [self.nsView setHidden:hidden];
    }

    - (void)setPassthrough:(BOOL)enable {    
        self.isMousePassthroughEnabled = enable;
    }

    - (void)setTransparent:(BOOL)transparent {
        if (transparent) {
            self.nsView.layer.opacity = 0;
        } else {
            self.nsView.layer.opacity = 1;
        }
        
    }


    - (void)toggleMirrorMode:(BOOL)enable {        
        NSView *subview = self.nsView;
        
        if (self.mirrorModeEnabled == enable) {
            return;
        }
        BOOL isLeftMouseButtonDown = ([NSEvent pressedMouseButtons] & (1 << 0)) != 0;
        if (isLeftMouseButtonDown) {
            return;
        }
        self.mirrorModeEnabled = enable;
        
        if (enable) {        
            CGFloat positionX = subview.frame.origin.x;
            CGFloat positionY = subview.frame.origin.y;            
            subview.frame = CGRectOffset(subview.frame, OFFSCREEN_OFFSET, OFFSCREEN_OFFSET);
            subview.layer.position = CGPointMake(positionX, positionY);
        } else {
            subview.frame = CGRectMake(subview.layer.position.x,
                                    subview.layer.position.y,
                                    subview.frame.size.width,
                                    subview.frame.size.height);
        }
    }


    - (void)resize:(NSRect)frame withMasksJSON:(const char *)masksJson {            
        NSView *subview = self.nsView;
        if (!subview) {
            return;    
        }        
        
        CGFloat adjustedX = floor(frame.origin.x);
        CGFloat adjustedWidth = ceilf(frame.size.width);
        CGFloat adjustedHeight = ceilf(frame.size.height);
        CGFloat adjustedY = floor(subview.superview.bounds.size.height - ceilf(frame.origin.y) - adjustedHeight);
        CGFloat adjustedYZ = floor(frame.origin.y);
        
        // TODO: move mirrorModeEnabled to abstractView
        if (self.mirrorModeEnabled) {   
            subview.frame = NSMakeRect(OFFSCREEN_OFFSET, OFFSCREEN_OFFSET, adjustedWidth, adjustedHeight);            
            subview.layer.position = CGPointMake(adjustedX, adjustedY);            
        } else {
            subview.frame = NSMakeRect(adjustedX, adjustedY, adjustedWidth, adjustedHeight);
        }

        CAShapeLayer* (^createMaskLayer)(void) = ^CAShapeLayer* {
            if (!masksJson || strlen(masksJson) == 0) {
                return nil;
            }
            NSString *jsonString = [NSString stringWithUTF8String:masksJson ?: ""];
            NSData *jsonData = [jsonString dataUsingEncoding:NSUTF8StringEncoding];
            if (!jsonData) {
                return nil;
            }
            NSError *error = nil;
            NSArray *rectsArray = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&error];
            if (!rectsArray || error) {
                return nil;
            }
            CGFloat heightToAdjust = self.nsView.layer.geometryFlipped ? 0 : adjustedHeight;
            
            NSArray<NSValue *> *processedRects = addOverlapRects(rectsArray, heightToAdjust);

            CAShapeLayer *maskLayer = [CAShapeLayer layer];
            maskLayer.frame = self.nsView.layer.bounds;
            CGMutablePathRef path = CGPathCreateMutable();
            CGPathAddRect(path, NULL, maskLayer.bounds);
            for (NSValue *rectValue in processedRects) {
                NSRect rect = [rectValue rectValue];
                CGPathAddRect(path, NULL, rect);
            }
            maskLayer.fillRule = kCAFillRuleEvenOdd;
            maskLayer.path = path;
            CGPathRelease(path);
            return maskLayer;
        };

        self.nsView.layer.mask = createMaskLayer();
        NSPoint currentMousePosition = [self.nsView.window mouseLocationOutsideOfEventStream];
        ContainerView *containerView = (ContainerView *)self.nsView.superview;    
        [containerView updateActiveWebviewForMousePosition:currentMousePosition];
    }
@end


@implementation ContainerView
    - (instancetype)initWithFrame:(NSRect)frameRect {
        self = [super initWithFrame:frameRect];
        if (self) {
            self.abstractViews = [NSMutableArray array]; 
            [self updateTrackingAreas];
        }
        return self;
    }

    - (void)updateTrackingAreas {    
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
        NSPoint mouseLocation = [self convertPoint:[event locationInWindow] fromView:nil];
        [self updateActiveWebviewForMousePosition:mouseLocation];
    }

    // This function tries to figure out which "abstractView" should be interactive
    // vs mirrored, based on mouse position and layering.
    - (void)updateActiveWebviewForMousePosition:(NSPoint)mouseLocation {    
        BOOL stillSearching = YES;    

        for (AbstractView * abstractView in self.abstractViews) {           

            if (abstractView.isMousePassthroughEnabled) {
                [abstractView toggleMirrorMode:YES];
                continue;
            }
            
            NSView *subview = abstractView.nsView;

            if (stillSearching) {
                NSRect subviewRenderLayerFrame = subview.layer.frame;
                if (NSPointInRect(mouseLocation, subviewRenderLayerFrame)){// && !subview.hidden) {
                    CAShapeLayer *maskLayer = (CAShapeLayer *)subview.layer.mask;
                    CGPathRef maskPath = maskLayer ? maskLayer.path : NULL;
                    if (maskPath) {                    
                        CGFloat mouseXInWebview = mouseLocation.x - subviewRenderLayerFrame.origin.x;
                        CGFloat mouseYInWebview = mouseLocation.y - subviewRenderLayerFrame.origin.y;
                        
                        // Note: WKWebkit uses geometryFlipped so the y coordinate is from the top not the bottom
                        // (the default on osx is from the bottom). The mouse y coordinate is from the bottom
                        // so we need to invert it to match the layer geometry
                        if (subview.layer.geometryFlipped) {                                                
                            mouseYInWebview = subviewRenderLayerFrame.size.height - (mouseLocation.y - subviewRenderLayerFrame.origin.y);                        
                        }

                        CGPoint mousePositionInMaskPath = CGPointMake(mouseXInWebview, mouseYInWebview);

                        if (!CGPathContainsPoint(maskPath, NULL, mousePositionInMaskPath, true)) {                        
                            [abstractView toggleMirrorMode:YES];                                                
                            continue;
                        }
                    }
                    
                    [abstractView toggleMirrorMode:NO];
                    stillSearching = NO;
                    continue;
                }
            }        
            [abstractView toggleMirrorMode:YES];
        }    
    }


    - (void)addAbstractView:(AbstractView *)abstractView {
        // Add to front of array so it's top-most first
        [self.abstractViews insertObject:abstractView atIndex:0];
    }

    - (void)removeAbstractViewWithId:(uint32_t)webviewId {
        NSInteger indexToRemove = -1;
        for (NSInteger i = 0; i < self.abstractViews.count; i++) {
            AbstractView * candidate = self.abstractViews[i];
            if (candidate.webviewId == webviewId) {
                [self.abstractViews removeObjectAtIndex:i];
                break;
            }
        }   
    }
@end

// ----------------------- URL Scheme & Navigation Delegates -----------------------

@implementation MyURLSchemeHandler
    - (void)webView:(WKWebView *)webView
    startURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
        NSURL *url = urlSchemeTask.request.URL;
        NSData *bodyData = urlSchemeTask.request.HTTPBody;
        NSString *bodyString = bodyData ? [[NSString alloc] initWithData:bodyData encoding:NSUTF8StringEncoding] : @"";
        
        NSData *data = nil;
        size_t contentLength = 0;
        const char *contentPtr = NULL;
        
        NSString *urlString = url.absoluteString;
        
        if ([urlString hasPrefix:@"views://"]) {
            // Remove the "views://" prefix.
            NSString *relativePath = [urlString substringFromIndex:7];

            if ([relativePath isEqualToString:@"internal/index.html"]) {
                // For internal content, call the native HTML resolver.
                // Assume getHTMLForWebviewSync returns a null-terminated C string.
                // contentPtr = getHTMLForWebviewSync(self.webviewId);
                contentPtr = callJsCallbackFromMainSync(^{return jsUtils.getHTMLForWebviewSync(self.webviewId);});
                if (contentPtr) {
                    contentLength = strlen(contentPtr);
                    data = [NSData dataWithBytes:contentPtr length:contentLength];
                }
                return;
            } 

            data = readViewsFile(urlString.UTF8String);
            
            if (data) {
                contentPtr = (const char *)data.bytes;
                contentLength = data.length;
            } 
        } else {
            NSLog(@"Unknown URL format: %@", urlString);
        }
        
        if (contentPtr && contentLength > 0) {
            // Determine MIME type using your getMimeTypeSync function.
            // const char *mimeTypePtr = getMimeTypeSync(url.absoluteString.UTF8String);
            const char *mimeTypePtr = callJsCallbackFromMainSync(^{return jsUtils.getMimeType(url.absoluteString.UTF8String);});
            NSString *rawMimeType = [NSString stringWithUTF8String:mimeTypePtr];

            NSString *mimeType;
            NSString *encodingName = nil;
            if ([rawMimeType hasPrefix:@"text/html"]) {
                mimeType = @"text/html";
                encodingName = @"UTF-8";  // Set encoding explicitly
            } else {
                // For non-text content or text content that doesn’t need explicit encoding
                mimeType = rawMimeType;
            }
            
            NSURLResponse *response = [[NSURLResponse alloc] initWithURL:url
                                                    MIMEType:mimeType
                                        expectedContentLength:contentLength
                                            textEncodingName:encodingName];
            [urlSchemeTask didReceiveResponse:response];
            [urlSchemeTask didReceiveData:data];
            [urlSchemeTask didFinish];
        } else {
            NSLog(@"============== ERROR ========== empty response");
            // Optionally, you might notify failure:
            // NSError *error = [NSError errorWithDomain:@"MyURLSchemeHandler" code:404 userInfo:nil];
            // [urlSchemeTask didFailWithError:error];
        }
       
    }
    - (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
        NSLog(@"Stopping URL scheme task for URL: %@", urlSchemeTask.request.URL);
    }
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

@implementation MyScriptMessageHandler
    - (void)userContentController:(WKUserContentController *)userContentController
        didReceiveScriptMessage:(WKScriptMessage *)message {
        NSString *body = message.body;
        const char *bodyCStr = strdup(body.UTF8String);
        self.zigCallback(self.webviewId, bodyCStr); 

        // Note: threadsafe JSCallbacks are invoked on the js worker thread, When called frequently they
        // can build up and take longer. Meanwhile objc GC auto free's the message body and the callback
        // ends up getting garbage.

        // So we duplicate it and give it plenty of time to execute (1 second delay vs. 0.1ms execution per invocation)
        // before freeing the memory
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            free((void*)bodyCStr);
        });              
    }
@end

// ----------------------- WKWebViewImpl -----------------------


@implementation WKWebViewImpl

    - (instancetype)initWithWebviewId:(uint32_t)webviewId
                            window:(NSWindow *)window
                            url:(const char *)url                                                   
                                frame:(NSRect)frame                    
                        autoResize:(bool)autoResize
                partitionIdentifier:(const char *)partitionIdentifier
                navigationCallback:(DecideNavigationCallback)navigationCallback
                webviewEventHandler:(WebviewEventHandler)webviewEventHandler
                bunBridgeHandler:(HandlePostMessage)bunBridgeHandler
                internalBridgeHandler:(HandlePostMessage)internalBridgeHandler
                electrobunPreloadScript:(const char *)electrobunPreloadScript
                customPreloadScript:(const char *)customPreloadScript
    {
        self = [super init];
        if (self) {        
            self.webviewId = webviewId;
            
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
                // TODO: Consider storing views handler globally and not on each AbstractView                
                assetSchemeHandler.webviewId = webviewId;
                [configuration setURLSchemeHandler:assetSchemeHandler forURLScheme:@"views"];
                
                // create WKWebView 
                self.webView = [[WKWebView alloc] initWithFrame:frame configuration:configuration];
                
                [self.webView setValue:@NO forKey:@"drawsBackground"];
                self.webView.layer.backgroundColor = [[NSColor clearColor] CGColor];
                self.webView.layer.opaque = NO;

                self.webView.autoresizingMask = NSViewNotSizable;

                if (autoResize) {
                    self.fullSize = YES;
                } else {                
                    self.fullSize = NO;
                }
                
                // retainObjCObject(self.webView);

                // delegates
                MyNavigationDelegate *navigationDelegate = [[MyNavigationDelegate alloc] init];
                navigationDelegate.zigCallback = navigationCallback;                
                navigationDelegate.zigEventHandler = webviewEventHandler;
                navigationDelegate.webviewId = webviewId;
                self.webView.navigationDelegate = navigationDelegate;
                objc_setAssociatedObject(self.webView, "NavigationDelegate", navigationDelegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

                MyWebViewUIDelegate *uiDelegate = [[MyWebViewUIDelegate alloc] init];
                uiDelegate.zigEventHandler = webviewEventHandler;
                uiDelegate.webviewId = webviewId;
                self.webView.UIDelegate = uiDelegate;
                objc_setAssociatedObject(self.webView, "UIDelegate", uiDelegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);                                    

                // postmessage
                // bunBridge
                MyScriptMessageHandler *bunHandler = [[MyScriptMessageHandler alloc] init];
                bunHandler.zigCallback = bunBridgeHandler;
                bunHandler.webviewId = webviewId;
                [self.webView.configuration.userContentController addScriptMessageHandler:bunHandler
                                                                                name:[NSString stringWithUTF8String:"bunBridge"]];

                objc_setAssociatedObject(self.webView, "bunBridgeHandler", bunHandler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

                // internalBridge
                MyScriptMessageHandler *webviewTagHandler = [[MyScriptMessageHandler alloc] init];
                webviewTagHandler.zigCallback = internalBridgeHandler;
                webviewTagHandler.webviewId = webviewId;
                [self.webView.configuration.userContentController addScriptMessageHandler:webviewTagHandler
                                                                                name:[NSString stringWithUTF8String:"internalBridge"]];

                objc_setAssociatedObject(self.webView, "webviewTagHandler", webviewTagHandler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

                // add subview
                [window.contentView addSubview:self.webView positioned:NSWindowAbove relativeTo:nil];
                CGFloat adjustedY = window.contentView.bounds.size.height - frame.origin.y - frame.size.height;
                self.webView.frame = NSMakeRect(frame.origin.x, adjustedY, frame.size.width, frame.size.height);

                ContainerView *containerView = (ContainerView *)window.contentView;
                [containerView addAbstractView:self];
                // self.webView.abstractView = self;
                
                
                
                // Note: in WkWebkit the webview is an NSView
                self.nsView = self.webView;            

                [self addPreloadScriptToWebView:electrobunPreloadScript];
                
                // Note: For custom preload scripts we support either inline js or a views:// style
                // url to a js file in the bundled views folder.
                if (strncmp(customPreloadScript, "views://", 8) == 0) {                    
                    NSData *scriptData = readViewsFile(customPreloadScript);
                    if (scriptData) {                        
                        NSString *scriptString = [[NSString alloc] initWithData:scriptData encoding:NSUTF8StringEncoding];                        
                        const char *scriptCString = [scriptString UTF8String];
                        [self updateCustomPreloadScript:scriptCString];
                    }
                } else {
                    [self updateCustomPreloadScript:customPreloadScript];
                }

                if (url) {                                   
                    [self loadURL:url];
                } 
                
                // associate
                objc_setAssociatedObject(self.webView, "WKWebViewImpl", self, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            });
        }
        return self;
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

        // DEBUG
        // [self.webView evaluateJavaScript:code
        //                   inFrame:nil
        //           inContentWorld:isolatedWorld
        //       completionHandler:^(id result, NSError *error) {
        //     if (error) {
        //         NSLog(@"JavaScript evaluation error: %@", error);
        //     } else {
        //         NSLog(@"JavaScript evaluation result: %@", result);
        //     }
        // }];
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

// ----------------------- CEF and NSApplication Setup (C++ and ObjC) -----------------------

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


// C++ classes for CEF:


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
        command_line->AppendSwitchWithValue("custom-scheme", "views"); 
        // Note: This stops CEF (Chromium) trying to access Chromium's storage for system-level things
        // like credential management. Using a mock keychain just means it doesn't use keychain
        // for credential storage. Other security features like cookies, https, etc. are unaffected.                
        command_line->AppendSwitch("use-mock-keychain");       
                
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

        // Log the CEF process_helper path
        // NSLog(@"CEF helper process path: %s", command_line->GetProgram().ToString().c_str());            
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

struct PreloadScript {
    std::string code;
    bool mainFrameOnly;
};

class ElectrobunResponseFilter : public CefResponseFilter {
private:
    std::string buffer_;
    bool has_head_;
    bool injected_;
    PreloadScript electrobun_script_;
    PreloadScript custom_script_;

public:
    ElectrobunResponseFilter(const PreloadScript& electrobunScript, 
                           const PreloadScript& customScript)
        : has_head_(false), 
          injected_(false),
          electrobun_script_(electrobunScript),
          custom_script_(customScript) {}
    
    virtual FilterStatus Filter(void* data_in,
                               size_t data_in_size,
                               size_t& data_in_read,
                               void* data_out,
                               size_t data_out_size,
                               size_t& data_out_written) override {

        // Check if we have scripts to inject
        if (electrobun_script_.code.empty() && custom_script_.code.empty()) {
            // Nothing to inject, just copy the data
            size_t copy_size = std::min(data_in_size, data_out_size);
            memcpy(data_out, data_in, copy_size);
            data_in_read = copy_size;
            data_out_written = copy_size;
            return RESPONSE_FILTER_DONE;
        }

        
        // Append the new data to our buffer
        if (data_in_size > 0) {
            buffer_.append(static_cast<char*>(data_in), data_in_size);
            data_in_read = data_in_size;
        } else {
            data_in_read = 0;
        }
        
        // Check if we've already injected our scripts
        if (injected_) {
            // Just copy data from our buffer to the output
            size_t copy_size = std::min(buffer_.size(), data_out_size);
            memcpy(data_out, buffer_.c_str(), copy_size);
            buffer_.erase(0, copy_size);
            data_out_written = copy_size;
            
            return buffer_.empty() ? RESPONSE_FILTER_DONE : RESPONSE_FILTER_NEED_MORE_DATA;
        }
        
        // Look for <head> tag if we haven't found it yet
        if (!has_head_) {
            size_t head_pos = buffer_.find("<head>");
            if (head_pos != std::string::npos) {
                has_head_ = true;
                
                // Inject our scripts after the <head> tag
                std::string scripts = "<script>\n";
                scripts += electrobun_script_.code;
                scripts += "\n</script>\n";
                
                if (!custom_script_.code.empty()) {
                    scripts += "<script>\n";
                    scripts += custom_script_.code;
                    scripts += "\n</script>\n";
                }
                
                buffer_.insert(head_pos + 6, scripts);  // Insert after <head>
                injected_ = true;
            }
        }
        
        // If we still haven't found <head> but the buffer is getting large,
        // we should check for <html> or just inject at the beginning
        if (!has_head_ && buffer_.size() > 1024) {
            size_t html_pos = buffer_.find("<html>");
            if (html_pos != std::string::npos) {
                // Inject after <html> tag
                std::string scripts = "<head>\n<script>\n";
                scripts += electrobun_script_.code;
                scripts += "\n</script>\n";
                
                if (!custom_script_.code.empty() ) {
                    scripts += "<script>\n";
                    scripts += custom_script_.code;
                    scripts += "\n</script>\n";
                }
                
                scripts += "</head>\n";
                
                buffer_.insert(html_pos + 6, scripts);  // Insert after <html>
            } else {
                // As a last resort, inject at the beginning
                std::string scripts = "<script>\n";
                scripts += electrobun_script_.code;
                scripts += "\n</script>\n";
                
                if (!custom_script_.code.empty() ) {
                    scripts += "<script>\n";
                    scripts += custom_script_.code;
                    scripts += "\n</script>\n";
                }
                
                buffer_.insert(0, scripts);
            }
            
            injected_ = true;
        }

        // Copy data from our buffer to the output
        size_t copy_size = std::min(buffer_.size(), data_out_size);
        memcpy(data_out, buffer_.c_str(), copy_size);
        buffer_.erase(0, copy_size);
        data_out_written = copy_size;
        
        return buffer_.empty() ? RESPONSE_FILTER_DONE : RESPONSE_FILTER_NEED_MORE_DATA;
    }

    virtual bool InitFilter() override {
        // Initialize any resources needed for filtering
        buffer_.clear();
        has_head_ = false;
        injected_ = false;
        return true;
    }
    
    IMPLEMENT_REFCOUNTING(ElectrobunResponseFilter);
};

CefRefPtr<ElectrobunApp> g_app;

class ElectrobunClient : public CefClient,
                        public CefRenderHandler,
                        public CefLoadHandler,
                        public CefRequestHandler,
                        public CefContextMenuHandler,
                        public CefKeyboardHandler,
                        public CefResourceRequestHandler  {
private:
    uint32_t webview_id_;
    HandlePostMessage bun_bridge_handler_;
    HandlePostMessage webview_tag_handler_;
    WebviewEventHandler webview_event_handler_;
    DecideNavigationCallback navigation_callback_; 
    
    
    PreloadScript electrobun_script_;
    PreloadScript custom_script_; 
    static const int MENU_ID_DEV_TOOLS = 1; 

     // Helper function to escape JavaScript code for embedding in a string
    std::string EscapeJavaScriptString(const std::string& input) {
        std::string result;
        result.reserve(input.size() * 2);  // Reserve space to avoid multiple allocations
        
        for (char c : input) {
            switch (c) {
                case '\\': result += "\\\\"; break;
                case '\'': result += "\\\'"; break;
                case '\"': result += "\\\""; break;
                case '\n': result += "\\n"; break;
                case '\r': result += "\\r"; break;
                case '\t': result += "\\t"; break;
                case '\b': result += "\\b"; break;
                case '\f': result += "\\f"; break;
                default:
                    if (c < 32 || c > 126) {
                        // Convert non-printable characters to Unicode escape sequences
                        char buf[7];
                        snprintf(buf, sizeof(buf), "\\u%04x", (unsigned char)c);
                        result += buf;
                    } else {
                        result += c;
                    }
            }
        }
        
        return result;
    }

    std::vector<std::shared_ptr<const char>> messageStrings_;

public:
    ElectrobunClient(uint32_t webviewId,
                     HandlePostMessage bunBridgeHandler,
                     HandlePostMessage internalBridgeHandler,
                     WebviewEventHandler webviewEventHandler,
                     DecideNavigationCallback navigationCallback)
        : webview_id_(webviewId)
        , bun_bridge_handler_(bunBridgeHandler)
        , webview_tag_handler_(internalBridgeHandler) 
        , webview_event_handler_(webviewEventHandler)
        , navigation_callback_(navigationCallback) {}    

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

    virtual CefRefPtr<CefRequestHandler> GetRequestHandler() override { 
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

 
    
    

    // Handle all navigation requests
    bool OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       CefRefPtr<CefRequest> request,
                       bool user_gesture,
                       bool is_redirect) override {
        std::string url = request->GetURL().ToString();
        bool shouldAllow = navigation_callback_(webview_id_, url.c_str());

        
        if (webview_event_handler_) {        
            webview_event_handler_(webview_id_, "will-navigate", url.c_str());
        }
        return !shouldAllow;  // Return true to cancel the navigation
    }

     virtual CefRefPtr<CefResourceRequestHandler> GetResourceRequestHandler(
        CefRefPtr<CefBrowser> browser,
        CefRefPtr<CefFrame> frame,
        CefRefPtr<CefRequest> request,
        bool is_navigation,
        bool is_download,
        const CefString& request_initiator,
        bool& disable_default_handling) override {
        // Return this object as the resource request handler
        return this;
    }
    
    // Response filter to modify HTML content
    CefRefPtr<CefResponseFilter> GetResourceResponseFilter(
        CefRefPtr<CefBrowser> browser,
        CefRefPtr<CefFrame> frame,
        CefRefPtr<CefRequest> request,
        CefRefPtr<CefResponse> response) override {
        
        // Only filter main frame HTML responses
        if (frame->IsMain() && 
            response->GetMimeType().ToString().find("html") != std::string::npos) {
            NSLog(@"Creating response filter for HTML content");
            return new ElectrobunResponseFilter(electrobun_script_, custom_script_);
        }
        
        return nullptr;
    }

    virtual void OnLoadStart(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefFrame> frame,
                           TransitionType transition_type) override {    

        std::string frameUrl = frame->GetURL().ToString();
        std::string scriptUrl = GetScriptExecutionUrl(frameUrl);

        // NSLog(@"OnLoadStart %s", frameUrl.c_str());//, electrobun_script_.code.c_str());           
    }   

    void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                  CefRefPtr<CefFrame> frame,
                  int httpStatusCode) override {
        if (frame->IsMain() && webview_event_handler_) {                                   
            webview_event_handler_(webview_id_,"did-navigate", frame->GetURL().ToString().c_str());            
        }
    }

   virtual bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                     CefRefPtr<CefFrame> frame,
                                     CefProcessId source_process,
                                     CefRefPtr<CefProcessMessage> message) override {
    
    std::string messageName = message->GetName().ToString();
    std::string messageContent = message->GetArgumentList()->GetString(0).ToString();
    
    char* contentCopy = strdup(messageContent.c_str());
    bool result = false;
    
    if (messageName == "BunBridgeMessage") {
        bun_bridge_handler_(webview_id_, contentCopy);
        result = true;
    } else if (messageName == "internalMessage") {
        webview_tag_handler_(webview_id_, contentCopy);
        result = true;
    }

    // Note: threadsafe JSCallbacks are invoked on the js worker thread, When called frequently they
    // can build up and take longer. Meanwhile objc GC auto free's the message body and the callback
    // ends up getting garbage.

    // So we duplicate it and give it plenty of time to execute (1 second delay vs. 0.1ms execution per invocation)
    // before freeing the memory
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        free((void*)contentCopy);
    });   
    
    return result;
}

    // Context Menu
    CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override {
        return this;
    }

    // Implement context menu callback
    void OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                            CefRefPtr<CefFrame> frame,
                            CefRefPtr<CefContextMenuParams> params,
                            CefRefPtr<CefMenuModel> model) override {
        // Add "Inspect Element" to context menu
        if (model->GetCount() > 0) {
            model->AddSeparator();
        }
        model->AddItem(MENU_ID_DEV_TOOLS, "Inspect Element");
    }

    bool OnContextMenuCommand(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefFrame> frame,
                        CefRefPtr<CefContextMenuParams> params,
                        int command_id,
                        EventFlags event_flags) override {
        if (command_id == MENU_ID_DEV_TOOLS) {
            CefWindowInfo windowInfo;
            CefBrowserSettings settings;
            
            // Create rect for devtools window
            CefRect devtools_rect(100, 100, 800, 600);
            // Set as child of the parent window
            windowInfo.SetAsChild(nullptr, devtools_rect);
            
            // Create point for inspect element
            CefPoint inspect_at(0, 0);
            
            browser->GetHost()->ShowDevTools(windowInfo, 
                                        browser->GetHost()->GetClient(), 
                                        settings, 
                                        inspect_at);
            return true;
        }
        return false;
    }

    // Keyboard Shortcut
    CefRefPtr<CefKeyboardHandler> GetKeyboardHandler() override {
        return this;
    }

    bool OnKeyEvent(CefRefPtr<CefBrowser> browser,
               const CefKeyEvent& event,
               CefEventHandle os_event) override {
       

        bool hasCommand = (event.modifiers & EVENTFLAG_COMMAND_DOWN) != 0;
        bool hasOption = (event.modifiers & EVENTFLAG_ALT_DOWN) != 0;                

                
        if (event.type == KEYEVENT_RAWKEYDOWN) {
            // Note: option changes the character for i, so we use the native_key_code
            // for the i key instead. cmd+option+i
            if (event.native_key_code == 34 &&
                (event.modifiers & EVENTFLAG_COMMAND_DOWN) &&
                (event.modifiers & EVENTFLAG_ALT_DOWN)) {
                CefWindowInfo windowInfo;
                CefBrowserSettings settings;
                
                
                // Create rect for devtools window
                CefRect devtools_rect(100, 100, 800, 600);
                // Set as child of the parent window
                windowInfo.SetAsChild(nullptr, devtools_rect);
                
                CefPoint inspect_at(0, 0);
                
                browser->GetHost()->ShowDevTools(windowInfo, 
                                            browser->GetHost()->GetClient(), 
                                            settings, 
                                            inspect_at);
                return true;
            }
        }
        return false;
    }

    

    IMPLEMENT_REFCOUNTING(ElectrobunClient);
    DISALLOW_COPY_AND_ASSIGN(ElectrobunClient);
};


@interface CEFWebViewImpl : AbstractView
    // @property (nonatomic, strong) WKWebView *webView;

    @property (nonatomic, assign) CefRefPtr<CefBrowser> browser;
    @property (nonatomic, assign) CefRefPtr<ElectrobunClient> client;


    - (instancetype)initWithWebviewId:(uint32_t)webviewId
                            window:(NSWindow *)window   
                            url:(const char *)url                                                
                                frame:(NSRect)frame                    
                        autoResize:(bool)autoResize
                partitionIdentifier:(const char *)partitionIdentifier
                navigationCallback:(DecideNavigationCallback)navigationCallback
                webviewEventHandler:(WebviewEventHandler)webviewEventHandler
                bunBridgeHandler:(HandlePostMessage)bunBridgeHandler
                internalBridgeHandler:(HandlePostMessage)internalBridgeHandler
                electrobunPreloadScript:(const char *)electrobunPreloadScript
                customPreloadScript:(const char *)customPreloadScript;

@end

bool initializeCEF() {
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
    // settings.log_severity = LOGSEVERITY_VERBOSE;
    
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


// The main scheme handler class
class ElectrobunSchemeHandler : public CefResourceHandler {
public:
     ElectrobunSchemeHandler(uint32_t webviewId)
    : webviewId_(webviewId), hasResponse_(false), offset_(0) {}

  bool Open(CefRefPtr<CefRequest> request,
            bool& handle_request,
            CefRefPtr<CefCallback> callback) override {

        std::string urlStr = request->GetURL().ToString();
        handle_request = true;
        responseData_.clear();
        hasResponse_ = false;
        offset_ = 0;

        
        // If the URL starts with "views://"
        if (urlStr.find("views://") == 0) {
            // Remove the prefix (7 characters)
            std::string relativePath = urlStr.substr(7);
            
            // Check if this is the internal HTML request.
            if (relativePath == "internal/index.html") {
                // Call into the JS utility to get HTML (using our bridging helper)                
                const char* htmlContent = callJsCallbackFromMainSync(^{return jsUtils.getHTMLForWebviewSync(webviewId_);});
                
                if (htmlContent) {
                    size_t len = strlen(htmlContent);
                    mimeType_ = "text/html";
                    responseData_.assign(htmlContent, htmlContent + len);
                    hasResponse_ = true;

                }
                
                return hasResponse_;
            }
      
            NSData *data = readViewsFile(urlStr.c_str());
            if (data) {   
                const char* mimeTypePtr = callJsCallbackFromMainSync(^{return jsUtils.getMimeType(urlStr.c_str());});
                
                if (mimeTypePtr) {
                    mimeType_ = std::string(mimeTypePtr);
                } else {
                    mimeType_ = "text/html"; // Fallback
                }

                responseData_.assign((const char*)data.bytes,
                                    (const char*)data.bytes + data.length);
                hasResponse_ = true;
            } 
        }
        else {
         NSLog(@"Unknown URL format: %s", urlStr.c_str());
        }

        return hasResponse_;
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
        // Optionally log cancellation.
    }

    private:
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
  ElectrobunSchemeHandlerFactory(uint32_t webviewId)
    : webviewId_(webviewId) {}

  CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> browser,
                                         CefRefPtr<CefFrame> frame,
                                         const CefString& scheme_name,
                                         CefRefPtr<CefRequest> request) override {
    return new ElectrobunSchemeHandler(webviewId_);
  }

private:
  uint32_t webviewId_;
  
  IMPLEMENT_REFCOUNTING(ElectrobunSchemeHandlerFactory);
  DISALLOW_COPY_AND_ASSIGN(ElectrobunSchemeHandlerFactory);
};





// Utility function for WKWebsiteDataStore creation:



CefRefPtr<CefRequestContext> CreateRequestContextForPartition(const char* partitionIdentifier,
                                                               uint32_t webviewId) {
  CefRequestContextSettings settings;
  if (!partitionIdentifier || !partitionIdentifier[0]) {
    settings.persist_session_cookies = false;
    settings.persist_user_preferences = false;
  } else {
    std::string identifier(partitionIdentifier);
    bool isPersistent = identifier.substr(0, 8) == "persist:";

    if (isPersistent) {
      std::string partitionName = identifier.substr(8);
      NSString* appSupportPath = [NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES) firstObject];
      NSString* cachePath = [[appSupportPath stringByAppendingPathComponent:@"Electrobun/CEF/Partitions"]
                              stringByAppendingPathComponent:[NSString stringWithUTF8String:partitionName.c_str()]];
      NSFileManager *fileManager = [NSFileManager defaultManager];
      if (![fileManager fileExistsAtPath:cachePath]) {
        [fileManager createDirectoryAtPath:cachePath withIntermediateDirectories:YES attributes:nil error:nil];
      }
      settings.persist_session_cookies = true;
      settings.persist_user_preferences = true;
      CefString(&settings.cache_path).FromString([cachePath UTF8String]);
    } else {
      settings.persist_session_cookies = false;
      settings.persist_user_preferences = false;
    }
  }

  CefRefPtr<CefRequestContext> context = CefRequestContext::CreateContext(settings, nullptr);

  // Register the new scheme handler factory.
  CefRefPtr<ElectrobunSchemeHandlerFactory> factory(new ElectrobunSchemeHandlerFactory(webviewId));
  context->RegisterSchemeHandlerFactory("views", "", factory);

  return context;
}

// ----------------------- CEFWebViewImpl -----------------------


@implementation CEFWebViewImpl {}

    - (instancetype)initWithWebviewId:(uint32_t)webviewId
                            window:(NSWindow *)window
                                url:(const char *)url                           
                            frame:(NSRect)frame                    
                        autoResize:(bool)autoResize
                partitionIdentifier:(const char *)partitionIdentifier
                navigationCallback:(DecideNavigationCallback)navigationCallback
                webviewEventHandler:(WebviewEventHandler)webviewEventHandler
                bunBridgeHandler:(HandlePostMessage)bunBridgeHandler
            internalBridgeHandler:(HandlePostMessage)internalBridgeHandler
            electrobunPreloadScript:(const char *)electrobunPreloadScript
            customPreloadScript:(const char *)customPreloadScript
    {
        self = [super init];
        if (self) {        
            self.webviewId = webviewId;

            if (autoResize) {
                self.fullSize = YES;
            } else {
                self.fullSize = NO;
            }

            void (^createCEFBrowser)(void) = ^{                
                [window makeKeyAndOrderFront:nil];
                CefBrowserSettings browserSettings;               

                CefWindowInfo window_info;
                
                NSView *contentView = window.contentView;            
                
                CGFloat adjustedY = contentView.bounds.size.height - frame.origin.y - frame.size.height;
                CefRect cefBounds((int)frame.origin.x,
                                (int)adjustedY,
                                (int)frame.size.width,
                                (int)frame.size.height);
                window_info.SetAsChild((__bridge void*)contentView, cefBounds);

                CefRefPtr<CefRequestContext> requestContext = CreateRequestContextForPartition(
                    partitionIdentifier,                    
                    webviewId
                );

                
                // Register the scheme handler factory for this webview
                CefRefPtr<ElectrobunSchemeHandlerFactory> factory(
                    new ElectrobunSchemeHandlerFactory(webviewId));
                                        
                
                self.client = new ElectrobunClient(
                    webviewId,  
                    bunBridgeHandler, 
                    internalBridgeHandler,
                    webviewEventHandler,
                    navigationCallback 
                );                

                // store the script values
                [self addPreloadScriptToWebView:electrobunPreloadScript];
                
                // Note: For custom preload scripts we support either inline js or a views:// style
                // url to a js file in the bundled views folder.
                if (strncmp(customPreloadScript, "views://", 8) == 0) {                    
                    NSData *scriptData = readViewsFile(customPreloadScript);
                    if (scriptData) {                        
                        NSString *scriptString = [[NSString alloc] initWithData:scriptData encoding:NSUTF8StringEncoding];                        
                        const char *scriptCString = [scriptString UTF8String];
                        [self updateCustomPreloadScript:scriptCString];
                    }
                } else {
                    [self updateCustomPreloadScript:customPreloadScript];
                }                            

                
                // Note: We must create a browser with about:blank first so that self.browser can be set
                // Otherwise we get a race condition where OOPIF events hit bun then get passed to the parent
                // webview which is still in the middle of a CreateBrowserSync and fails to call
                // self.browser->GetMainFrame()->ExecuteJavascript.
                self.browser = CefBrowserHost::CreateBrowserSync(
                    window_info, self.client, CefString("about:blank"), browserSettings, nullptr, requestContext);

                if (self.browser) {
                    CefWindowHandle handle = self.browser->GetHost()->GetWindowHandle();
                    self.nsView = (__bridge NSView *)handle;                
                    self.nsView.autoresizingMask = NSViewNotSizable;
                    
                    
                    self.nsView.layer.backgroundColor = [[NSColor clearColor] CGColor];
                    self.nsView.layer.opaque = NO;                                
                }


                ContainerView *containerView = (ContainerView *)window.contentView;
                [containerView addAbstractView:self];

                if (url && url[0] != '\0') {    
                    self.browser->GetMainFrame()->LoadURL(CefString(url));
                }                                                                                             
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
                        createCEFBrowser();
                        
                    }
                }];
            }
            [window makeKeyAndOrderFront:nil];
            dispatch_async(dispatch_get_main_queue(), ^{               
                // createCEFBrowser();
                // NSLog(@"-----------------> DISPATCH 1");
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


    - (void)loadURL:(const char *)urlString {
        if (!self.browser)
            return;

        CefString cefUrl = urlString ? urlString : "";
        self.browser->GetMainFrame()->LoadURL(cefUrl);
    }

    - (void)goBack {
        if (self.browser)
            self.browser->GoBack();
    }

    - (void)goForward {
        if (self.browser)
            self.browser->GoForward();
    }

    - (void)reload {
        if (self.browser)
            self.browser->Reload();
    }

    - (void)remove {
        NSLog(@"REMOVE >>>>>>>>>>>>>>");
        // Stop loading, close the browser, remove from superview, etc.
        if (self.browser) {
            // Tells CEF to close the browser window
            self.browser->GetHost()->CloseBrowser(false);
            self.browser = nullptr;
        }
        if (self.nsView) {
            [self.nsView removeFromSuperview];
            self.nsView = nil;
        }
    }


    - (BOOL)canGoBack {
        if (!self.browser) return NO;
        return self.browser->CanGoBack() ? YES : NO;
    }

    - (BOOL)canGoForward {
        if (!self.browser) return NO;
        return self.browser->CanGoForward() ? YES : NO;
    }

    - (void)evaluateJavaScriptWithNoCompletion:(const char*)jsString {    
        if (!jsString) return;
        
        CefRefPtr<CefFrame> mainFrame = self.browser->GetMainFrame();
        
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

    - (void)callAsyncJavascript:(const char*)messageId 
                    jsString:(const char*)jsString 
                    webviewId:(uint32_t)webviewId 
                hostWebviewId:(uint32_t)hostWebviewId 
            completionHandler:(callAsyncJavascriptCompletionHandler)completionHandler {
        

        NSLog(@"TODO: Implement callAsyncJavascript for CEF when refactoring the entire RPC system");
        completionHandler(messageId, webviewId, hostWebviewId, "\"\"");   
    }

    - (void)addPreloadScriptToWebView:(const char*)jsString {
        if (!jsString) return;
        
        std::string script(jsString);
        self.client->AddPreloadScript(script);
    }

    - (void)updateCustomPreloadScript:(const char*)jsString {   
    if (!jsString) return;
        
        std::string script(jsString);        
        self.client->UpdateCustomPreloadScript(script);
    }

@end


// ----------------------- AppDelegate & WindowDelegate -----------------------

@implementation AppDelegate
    - (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {    
        return NSTerminateNow;
    }
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
        ContainerView *containerView = [window contentView];
        NSRect fullFrame = [window frame];
        fullFrame.origin.x = 0;
        fullFrame.origin.y = 0;
                
        for (AbstractView *abstractView in containerView.abstractViews) {                       
            if (abstractView.fullSize) {            
                [abstractView resize:fullFrame withMasksJSON:""];
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

/*
 * =============================================================================
 * 6. EXTERN "C" BRIDGING FUNCTIONS
 * =============================================================================
 */

// Note: This is executed from the main bun thread
extern "C" void runNSApplication() {      
    useCEF = isCEFAvailable();    
    
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

extern "C" void killApp() {
    // Execute on main thread
    dispatch_async(dispatch_get_main_queue(), ^{
        // This will terminate the entire process, including Bun and all its threads
        exit(1); 
    });
}

extern "C" void shutdownApplication() {
    dispatch_async(dispatch_get_main_queue(), ^{   
        CefShutdown();
    });
}



extern "C" AbstractView* initWebview(uint32_t webviewId,
                        NSWindow *window,
                        const char *renderer,
                        const char *url,                                                
                        double x, double y,
                        double width, double height,                        
                        bool autoResize,
                        const char *partitionIdentifier,
                        DecideNavigationCallback navigationCallback,
                        WebviewEventHandler webviewEventHandler,
                        HandlePostMessage bunBridgeHandler,
                        HandlePostMessage internalBridgeHandler,
                        const char *electrobunPreloadScript,
                        const char *customPreloadScript ) {

    NSRect frame = NSMakeRect(x, y, width, height);     
 
    __block AbstractView *impl = nil;

    dispatch_sync(dispatch_get_main_queue(), ^{
        Class ImplClass = (strcmp(renderer, "cef") == 0 && useCEF) ? [CEFWebViewImpl class] : [WKWebViewImpl class];    

        impl = [[ImplClass alloc] initWithWebviewId:webviewId
                                        window:window
                                        url:strdup(url)
                                        frame:frame                                        
                                        autoResize:autoResize
                                        partitionIdentifier:strdup(partitionIdentifier)
                                        navigationCallback:navigationCallback
                                        webviewEventHandler:webviewEventHandler
                                        bunBridgeHandler:bunBridgeHandler
                                        internalBridgeHandler:internalBridgeHandler
                                        electrobunPreloadScript:strdup(electrobunPreloadScript)
                                        customPreloadScript:strdup(customPreloadScript)];

    });

    return impl;
}

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

extern "C" void loadURLInWebView(AbstractView *abstractView, const char *urlString) {
    [abstractView loadURL:urlString];
}

extern "C" void webviewGoBack(AbstractView *abstractView) {    
    [abstractView goBack];
}

extern "C" void webviewGoForward(AbstractView *abstractView) {
    [abstractView goForward];
}

extern "C" void webviewReload(AbstractView *abstractView) {
    [abstractView reload];
}

extern "C" void webviewRemove(AbstractView *abstractView) {    
    [abstractView remove];
}

extern "C" BOOL webviewCanGoBack(AbstractView *abstractView) {        
    return [abstractView canGoBack];
}

extern "C" BOOL webviewCanGoForward(AbstractView *abstractView) {    
    return [abstractView canGoForward];
}

extern "C" void evaluateJavaScriptWithNoCompletion(AbstractView *abstractView, const char *script) {                    
    [abstractView evaluateJavaScriptWithNoCompletion:script];        
}

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

extern "C" void callAsyncJavaScript(const char *messageId,
                                    AbstractView *abstractView,
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

extern "C" void addPreloadScriptToWebView(AbstractView *abstractView, const char *scriptContent, BOOL forMainFrameOnly) {                
    [abstractView addPreloadScriptToWebView:scriptContent];    
}

// todo: remove identifier and add option forMainFrameOnly
extern "C" void updatePreloadScriptToWebView(AbstractView *abstractView,
                                             const char *scriptIdentifier,
                                             const char *scriptContent,
                                             BOOL forMainFrameOnly) {
    [abstractView updateCustomPreloadScript:scriptContent];    
}

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

extern "C" void webviewSetTransparent(AbstractView *abstractView, BOOL transparent) {    
        [abstractView setTransparent:transparent];    
}

extern "C" void webviewSetPassthrough(AbstractView *abstractView, BOOL enablePassthrough) {    
        [abstractView setPassthrough:enablePassthrough];    
}

extern "C" void webviewSetHidden(AbstractView *abstractView, BOOL hidden) {   
        [abstractView setHidden:hidden];    
}

extern "C" NSRect createNSRectWrapper(double x, double y, double width, double height) {
    return NSMakeRect(x, y, width, height);
}


NSWindow *createNSWindowWithFrameAndStyle(uint32_t windowId,
                                                     createNSWindowWithFrameAndStyleParams config,
                                                     WindowCloseHandler zigCloseHandler,
                                                     WindowMoveHandler zigMoveHandler,
                                                     WindowResizeHandler zigResizeHandler) {
    
    NSScreen *primaryScreen = [NSScreen screens][0];
    NSRect screenFrame = [primaryScreen frame];
    config.frame.origin.y = screenFrame.size.height - config.frame.origin.y;
    
    NSWindow *window = [[NSWindow alloc] initWithContentRect:config.frame
                                                   styleMask:config.styleMask
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

    // return (void*)window;
    
}

extern "C" void testFFI2(void (*completionHandler)()) {
    NSLog(@"C++  TEST FFI 2 0");
    completionHandler();
    NSLog(@"C++  TEST FFI 2 1");
}

extern "C" NSWindow *createWindowWithFrameAndStyleFromWorker(
  uint32_t windowId,
  double x, double y,
  double width, double height,
  uint32_t styleMask,   
  const char* titleBarStyle,
  WindowCloseHandler zigCloseHandler,
  WindowMoveHandler zigMoveHandler,
  WindowResizeHandler zigResizeHandler
  ) {

    NSRect frame = NSMakeRect(x, y, width, height);
  
    // Create the params struct
    createNSWindowWithFrameAndStyleParams config = {
        .frame = frame,
        .styleMask = styleMask,
        .titleBarStyle = titleBarStyle
    };

    // Use a dispatch semaphore to wait for the window creation to complete


    __block NSWindow* window = nil;
    dispatch_sync(dispatch_get_main_queue(), ^{
        window = createNSWindowWithFrameAndStyle(
            windowId,
            config,
            zigCloseHandler,
            zigMoveHandler,
            zigResizeHandler
        );
    });

    return window;        
}

extern "C" void makeNSWindowKeyAndOrderFront(NSWindow *window) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [window makeKeyAndOrderFront:nil];
    });
}

extern "C" void setNSWindowTitle(NSWindow *window, const char *title) {
    NSString *titleString = [NSString stringWithUTF8String:title ?: ""];
    
    dispatch_sync(dispatch_get_main_queue(), ^{
        [window setTitle:titleString];
    });
}

extern "C" void closeNSWindow(NSWindow *window) {
    dispatch_sync(dispatch_get_main_queue(), ^{
        [window close];
    });
}

extern "C" void resizeWebview(AbstractView *abstractView, double x, double y, double width, double height, const char *masksJson) {    
    NSRect frame = NSMakeRect(x, y, width, height);
    dispatch_async(dispatch_get_main_queue(), ^{
        [abstractView resize:frame withMasksJSON:masksJson];
    });
}

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


    __block NSOpenPanel *panel;
    __block NSInteger result = NSModalResponseCancel;
    __block NSString *concatenatedPaths = nil;
    
    dispatch_sync(dispatch_get_main_queue(), ^{        
        panel = [NSOpenPanel openPanel];        
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
                
        result = [panel runModal]; // Run the modal dialog on the main thread        
        
        if (result == NSModalResponseOK) {            
            NSArray<NSURL *> *selectedFileURLs = [panel URLs];
            NSMutableArray<NSString *> *pathStrings = [NSMutableArray array];
            for (NSURL *u in selectedFileURLs) {
                [pathStrings addObject:u.path];
            }
            concatenatedPaths = [pathStrings componentsJoinedByString:@","];
        }        
    });
    
    // Return the result after the dispatch_sync completes
    return (concatenatedPaths) ? strdup([concatenatedPaths UTF8String]) : NULL;
}


extern "C" NSStatusItem* createTray(uint32_t trayId, const char *title, const char *pathToImage, bool isTemplate,
                                    uint32_t width, uint32_t height, ZigStatusItemHandler zigTrayItemHandler) {
    
    __block NSStatusItem* trayPtr;
    
    dispatch_sync(dispatch_get_main_queue(), ^{
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

        trayPtr = statusItem;
    });

    return trayPtr;
    
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


extern "C" void setTrayMenuFromJSON(NSStatusItem *statusItem, const char *jsonString) {
    dispatch_async(dispatch_get_main_queue(), ^{
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
    });
}

extern "C" void setTrayMenu(NSStatusItem *statusItem, const char *menuConfig) {
    if (statusItem) {
        setTrayMenuFromJSON(statusItem, menuConfig);
    }
}

extern "C" void setApplicationMenu(const char *jsonString, ZigStatusItemHandler zigTrayItemHandler) {
    NSLog(@"Setting application menu from JSON in objc");
    dispatch_async(dispatch_get_main_queue(), ^{
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
    });
}

extern "C" void showContextMenu(const char *jsonString, ZigStatusItemHandler contextMenuHandler) {
    dispatch_async(dispatch_get_main_queue(), ^{
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
    });
}

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


extern "C" void setJSUtils(GetMimeType getMimeType, GetHTMLForWebviewSync getHTMLForWebviewSync) {    
    jsUtils.getMimeType = getMimeType;
    jsUtils.getHTMLForWebviewSync = getHTMLForWebviewSync;
    
    // create a dispatch queue on the current thread (worker thread) that
    // can later be called from main
    dispatch_queue_attr_t attr = dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_DEFAULT, 0);
    jsWorkerQueue = dispatch_queue_create("com.electrobun.jsworker", attr);    


    // size_t contentLength = 0;
    // jsUtils.viewsHandler(0, "hi", "ho", &contentLength);

    NSLog(@"got mimetype: %s", jsUtils.getMimeType("test.jpg"));
    // NSLog(@"got mimetype: %s", getMimeTypeSync("test.png"));

  
    
}








