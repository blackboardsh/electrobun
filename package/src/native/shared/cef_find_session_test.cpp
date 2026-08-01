#include <cassert>

#include "cef_find_session.h"

int main() {
    electrobun::CefFindSession firstView;
    electrobun::CefFindSession secondView;

    assert(!firstView.begin("needle", false));
    assert(firstView.begin("needle", false));

    assert(!firstView.begin("needle", true));
    assert(firstView.begin("needle", true));

    assert(!firstView.begin("other", true));
    assert(firstView.begin("other", true));

    assert(!secondView.begin("other", true));
    assert(firstView.begin("other", true));

    firstView.reset();
    assert(!firstView.begin("other", true));
    return 0;
}
