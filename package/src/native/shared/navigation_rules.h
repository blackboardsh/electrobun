// navigation_rules.h - Cross-platform navigation rules checking
// Handles URL navigation rules with glob pattern matching
// Used across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_NAVIGATION_RULES_H
#define ELECTROBUN_NAVIGATION_RULES_H

#include <string>
#include <vector>
#include "glob_match.h"

namespace electrobun {

// Represents a single navigation rule
// Rules starting with "^" are block rules (inverts the match)
struct NavigationRule {
    std::string pattern;
    bool isBlockRule;

    NavigationRule(const std::string& ruleString) {
        if (!ruleString.empty() && ruleString[0] == '^') {
            isBlockRule = true;
            pattern = ruleString.substr(1);
        } else {
            isBlockRule = false;
            pattern = ruleString;
        }
    }
};

// Check if a URL should be allowed based on navigation rules
// Uses "last match wins" semantics
// Returns true if navigation should be allowed, false if blocked
//
// Rules are processed in order:
// - Normal rules (no ^ prefix): if URL matches, allow navigation
// - Block rules (^ prefix): if URL matches, block navigation
// - Last matching rule determines the outcome
// - If no rules match, returns defaultAllow
inline bool checkNavigationRulesForUrl(const std::vector<std::string>& rules,
                                       const std::string& url,
                                       bool defaultAllow = true) {
    bool shouldAllow = defaultAllow;
    bool anyMatch = false;

    for (const auto& ruleString : rules) {
        if (ruleString.empty()) continue;

        NavigationRule rule(ruleString);

        if (globMatch(rule.pattern, url)) {
            anyMatch = true;
            // If it's a block rule, matching means we should NOT allow
            // If it's a normal rule, matching means we SHOULD allow
            shouldAllow = !rule.isBlockRule;
        }
    }

    return shouldAllow;
}

// Overload that takes a comma-separated rules string
inline bool checkNavigationRulesForUrl(const std::string& rulesString,
                                       const std::string& url,
                                       bool defaultAllow = true) {
    std::vector<std::string> rules;

    size_t start = 0;
    size_t end = rulesString.find(',');

    while (end != std::string::npos) {
        std::string rule = rulesString.substr(start, end - start);
        // Trim whitespace
        size_t first = rule.find_first_not_of(" \t");
        size_t last = rule.find_last_not_of(" \t");
        if (first != std::string::npos) {
            rules.push_back(rule.substr(first, last - first + 1));
        }
        start = end + 1;
        end = rulesString.find(',', start);
    }

    // Add the last rule
    std::string rule = rulesString.substr(start);
    size_t first = rule.find_first_not_of(" \t");
    size_t last = rule.find_last_not_of(" \t");
    if (first != std::string::npos) {
        rules.push_back(rule.substr(first, last - first + 1));
    }

    return checkNavigationRulesForUrl(rules, url, defaultAllow);
}

} // namespace electrobun

#endif // ELECTROBUN_NAVIGATION_RULES_H
