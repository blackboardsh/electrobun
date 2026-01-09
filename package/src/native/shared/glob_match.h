// glob_match.h - Cross-platform glob pattern matching utility
// Used for navigation rules matching across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.
// Supports * wildcard only, case-insensitive matching.

#ifndef ELECTROBUN_GLOB_MATCH_H
#define ELECTROBUN_GLOB_MATCH_H

#include <string>
#include <cctype>

namespace electrobun {

// Simple case-insensitive glob matcher (supports * wildcard only)
// Returns true if text matches the glob pattern
//
// Examples:
//   globMatch("*.example.com", "www.example.com") -> true
//   globMatch("https://*.wikipedia.org/*", "https://en.wikipedia.org/wiki/Test") -> true
//   globMatch("exact.match.com", "exact.match.com") -> true
//   globMatch("*.google.com", "www.bing.com") -> false
//
inline bool globMatch(const std::string& pattern, const std::string& text) {
    size_t p = 0, t = 0;
    size_t starP = std::string::npos, starT = 0;

    while (t < text.size()) {
        if (p < pattern.size() && (std::tolower(static_cast<unsigned char>(pattern[p])) ==
                                    std::tolower(static_cast<unsigned char>(text[t])))) {
            // Characters match (case-insensitive)
            p++;
            t++;
        } else if (p < pattern.size() && pattern[p] == '*') {
            // Wildcard: remember position and try matching zero characters
            starP = p++;
            starT = t;
        } else if (starP != std::string::npos) {
            // Mismatch but we have a previous wildcard: backtrack
            p = starP + 1;
            t = ++starT;
        } else {
            // Mismatch and no wildcard to backtrack to
            return false;
        }
    }

    // Skip any trailing wildcards in pattern
    while (p < pattern.size() && pattern[p] == '*') {
        p++;
    }

    // Match if we consumed the entire pattern
    return p == pattern.size();
}

} // namespace electrobun

#endif // ELECTROBUN_GLOB_MATCH_H
