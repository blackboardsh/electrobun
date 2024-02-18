#import <WebKit/WebKit.h>


void invokeDecisionHandler(void (^decisionHandler)(WKNavigationActionPolicy), WKNavigationActionPolicy policy);

const char* getUrlFromNavigationAction(WKNavigationAction *navigationAction);

const char* getBodyFromScriptMessage(WKScriptMessage *message);

void evaluateJavaScriptWithNoCompletion(WKWebView *webView, const char *jsString);

void* getNilValue();