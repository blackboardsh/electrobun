#ifndef ELECTROBUN_CEF_FIND_SESSION_H
#define ELECTROBUN_CEF_FIND_SESSION_H

#include <string>
#include <utility>

namespace electrobun {

// CEF expects findNext=false for a new search and true when advancing an
// existing search. Each webview owns one session so searches cannot leak
// between views.
class CefFindSession {
public:
    bool begin(const char* searchText, bool matchCase) {
        std::string nextSearchText(searchText ? searchText : "");
        const bool findNext = active_ &&
            lastSearchText_ == nextSearchText &&
            lastMatchCase_ == matchCase;

        lastSearchText_ = std::move(nextSearchText);
        lastMatchCase_ = matchCase;
        active_ = true;
        return findNext;
    }

    void reset() {
        lastSearchText_.clear();
        lastMatchCase_ = false;
        active_ = false;
    }

private:
    std::string lastSearchText_;
    bool lastMatchCase_ = false;
    bool active_ = false;
};

} // namespace electrobun

#endif // ELECTROBUN_CEF_FIND_SESSION_H
