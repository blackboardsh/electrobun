#import "DecisionHandlerWrapper.h"

void invokeDecisionHandler(void (^decisionHandler)(WKNavigationActionPolicy), WKNavigationActionPolicy policy) {
    if (decisionHandler != NULL) {
        decisionHandler(policy);
    }
}