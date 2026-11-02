#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

#include <arpa/inet.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <string>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>

#include "frame_policy.h"
#include "../shared/navigation_rules.h"

static int failures = 0;
#define CHECK(condition, message) do { \
    if (!(condition)) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; } \
} while (false)

// Serve the real browser shape that triggered the regression: an opaque
// sandboxed HTTP child with an external ES module inside a views:// window.
class ChildServer {
    int listener = -1;
    std::thread worker;
    std::atomic<bool> running{true};
public:
    std::string origin;
    std::atomic<unsigned> requests{0};

    ChildServer()
    {
        listener = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (listener < 0 || bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof(address)) || listen(listener, 8))
            std::abort();
        socklen_t length = sizeof(address);
        if (getsockname(listener, reinterpret_cast<sockaddr *>(&address), &length))
            std::abort();
        origin = "http://127.0.0.1:" + std::to_string(ntohs(address.sin_port));
        worker = std::thread([this] {
            while (running) {
                const int client = accept(listener, nullptr, nullptr);
                if (client < 0) break;
                int enabled = 1;
                setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
                timeval timeout{2, 0};
                setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
                char request[4096]{};
                const auto size = recv(client, request, sizeof(request) - 1, 0);
                if (size > 0) {
                    ++requests;
                    const bool module = std::string(request, size).starts_with("GET /child.js ");
                    const std::string body = module
                        ? "document.body.textContent='Git settings loaded';"
                          "window.webkit.messageHandlers.privileged.postMessage('child');"
                          "let replyRejected=false;try{await window.webkit.messageHandlers.privilegedReply.postMessage('child')}catch{replyRejected=true}"
                          "parent.postMessage({ready:true,text:document.body.textContent,replyRejected},'*');"
                        : "<!doctype html><title>Embedded settings</title><body>Loading<script type=module src='/child.js'></script>";
                    std::string response = "HTTP/1.1 200 OK\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: ";
                    response += module ? "application/javascript" : "text/html";
                    if (!module) response += "\r\nContent-Security-Policy: sandbox allow-scripts allow-forms allow-downloads";
                    response += "\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
                    size_t offset = 0;
                    while (offset < response.size()) {
                        const auto written = send(client, response.data() + offset, response.size() - offset, 0);
                        if (written <= 0) break;
                        offset += written;
                    }
                }
                close(client);
            }
        });
    }

    ~ChildServer()
    {
        running = false;
        shutdown(listener, SHUT_RDWR);
        close(listener);
        worker.join();
    }
};

@interface FramePolicyProbe : NSObject <WKURLSchemeHandler, WKNavigationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply>
@property(nonatomic, copy) NSString *childURL;
@property(nonatomic, assign) NSUInteger allowedChildren;
@property(nonatomic, assign) NSUInteger deniedMainNavigations;
@property(nonatomic, assign) NSUInteger acceptedMainMessages;
@property(nonatomic, assign) NSUInteger rejectedChildMessages;
@property(nonatomic, assign) NSUInteger acceptedMainReplyMessages;
@property(nonatomic, assign) NSUInteger rejectedChildReplyMessages;
@property(nonatomic, assign) BOOL childReady;
@end

@implementation FramePolicyProbe
- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task
{
    (void)webView;
    NSString *html = [NSString stringWithFormat:
        @"<!doctype html><title>Trusted window</title><script>"
         "window.addEventListener('message',e=>{if(e.data?.ready)window.webkit.messageHandlers.report.postMessage(e.data)});"
         "window.webkit.messageHandlers.privileged.postMessage('main');"
         "window.webkit.messageHandlers.privilegedReply.postMessage('main');"
         "</script><iframe sandbox='allow-scripts allow-forms allow-downloads' src='%@'></iframe>", self.childURL];
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:task.request.URL
        statusCode:200 HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type": @"text/html", @"Access-Control-Allow-Origin": @"*"}];
    [task didReceiveResponse:response];
    [task didReceiveData:[html dataUsingEncoding:NSUTF8StringEncoding]];
    [task didFinish];
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task
{
    (void)webView;
    (void)task;
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler
{
    (void)webView;
    bool allow = true;
    if (electrobun::shouldApplyMainFrameNavigationRules(action)) {
        allow = electrobun::checkNavigationRulesForUrl(
            std::vector<std::string>{"^*", "views://dashui/index.html"}, action.request.URL.absoluteString.UTF8String);
        if (!allow) ++self.deniedMainNavigations;
    } else {
        ++self.allowedChildren;
    }
    decisionHandler(allow ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message
{
    (void)controller;
    if ([message.name isEqualToString:@"privileged"]) {
        if (!electrobun::isMainFrameScriptMessage(message)) {
            ++self.rejectedChildMessages;
            return;
        }
        CHECK([message.body isEqual:@"main"], "only the trusted document may reach the privileged callback");
        ++self.acceptedMainMessages;
    } else {
        CHECK(electrobun::isMainFrameScriptMessage(message), "child status must be forwarded by the main document");
        self.childReady = [message.body[@"text"] isEqual:@"Git settings loaded"] && [message.body[@"replyRejected"] boolValue];
    }
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message
    replyHandler:(void (^)(id _Nullable, NSString *_Nullable))replyHandler
{
    (void)controller;
    if (!electrobun::isMainFrameScriptMessage(message)) {
        ++self.rejectedChildReplyMessages;
        replyHandler(nil, @"Native messages are only available to the main frame");
        return;
    }
    CHECK([message.body isEqual:@"main"], "only the trusted document may reach a native reply callback");
    ++self.acceptedMainReplyMessages;
    replyHandler(@"ok", nil);
}
@end

static bool waitUntil(const std::function<bool()> &ready)
{
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!ready() && deadline.timeIntervalSinceNow > 0)
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    return ready();
}

int main()
{
    @autoreleasepool {
        CHECK(electrobun::shouldApplyMainFrameNavigationRules(nil), "missing frame identity must retain navigation rules");
        CHECK(!electrobun::isMainFrameScriptMessage(nil), "missing message frame must not acquire native authority");
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        ChildServer server;
        FramePolicyProbe *probe = [[FramePolicyProbe alloc] init];
        probe.childURL = [NSString stringWithUTF8String:(server.origin + "/child.html").c_str()];
        WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
        configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
        [configuration setURLSchemeHandler:probe forURLScheme:@"views"];
        [configuration.userContentController addScriptMessageHandler:probe name:@"privileged"];
        [configuration.userContentController addScriptMessageHandler:probe name:@"report"];
        [configuration.userContentController addScriptMessageHandlerWithReply:probe contentWorld:[WKContentWorld pageWorld] name:@"privilegedReply"];
        WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 640, 480) configuration:configuration];
        view.navigationDelegate = probe;
        [view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"views://dashui/index.html"]]];
        CHECK(waitUntil([&] { return probe.childReady && probe.rejectedChildMessages == 1; }), "sandboxed iframe module must render while its direct native bridge call is rejected");
        CHECK(probe.allowedChildren >= 1, "the real iframe navigation must bypass main-document rules");
        CHECK(server.requests == 2, "both child HTML and ES module must load");
        CHECK(probe.acceptedMainMessages == 1, "trusted main bridge calls must still work");
        CHECK(probe.rejectedChildMessages == 1, "opaque child must not reach privileged native callback");
        CHECK(probe.acceptedMainReplyMessages == 1, "trusted main bridge replies must still work");
        CHECK(probe.rejectedChildReplyMessages == 1, "opaque child native reply calls must be rejected");

        NSString *script = [NSString stringWithFormat:@"location.href='%@'", probe.childURL];
        [view evaluateJavaScript:script completionHandler:nil];
        CHECK(waitUntil([&] { return probe.deniedMainNavigations == 1; }), "same child URL must be rejected as a top-level navigation");
        CHECK([view.URL.absoluteString isEqualToString:@"views://dashui/index.html"], "trusted main URL must remain unchanged");
        CHECK(server.requests == 2, "blocked top-level navigation must not request the child URL");
        view.navigationDelegate = nil;
        [view stopLoading];
        [configuration.userContentController removeAllScriptMessageHandlers];
    }
    if (failures) return 1;
    std::printf("PASS: macOS iframe loading, main-document navigation, and native bridge isolation\n");
    return 0;
}
