#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

void createWebView(const char *url) {
    @autoreleasepool {
        // Set default URL to Google if none is provided
        const char *defaultUrl = "https://www.google.com";
        if (url == NULL || strlen(url) == 0) {
            url = defaultUrl;
        }

        NSApplication *app = [NSApplication sharedApplication];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 800, 600)
                                                       styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
                                                         backing:NSBackingStoreBuffered
                                                           defer:NO];
        [window cascadeTopLeftFromPoint:NSMakePoint(20,20)];
        [window setTitle:@"Bun WebView"];
        [window makeKeyAndOrderFront:nil];

        WKWebView *webView = [[WKWebView alloc] initWithFrame:[[window contentView] bounds]];
        [[window contentView] addSubview:webView];
        NSURL *nsurl = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
        NSURLRequest *nsrequest = [NSURLRequest requestWithURL:nsurl];
        [webView loadRequest:nsrequest];

        [app run];
    }
}