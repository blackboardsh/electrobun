struct WebviewEvent {
    webview_id: u32,
    name: String,
    detail: String,
}

// Closing a Windows window posts WM_CLOSE; callbacks already in flight can
// arrive after the next test starts. Keep each view and event's evidence
// separate instead of sharing one counter and one last-detail string.
pub struct WebviewObservations {
    events: Vec<WebviewEvent>,
}

impl WebviewObservations {
    pub const fn new() -> Self {
        Self { events: Vec::new() }
    }

    pub fn clear(&mut self) {
        self.events.clear();
    }

    pub fn record(&mut self, webview_id: u32, name: &str, detail: &str) {
        if self.events.iter().any(|event| {
            event.webview_id == webview_id && event.name == name && event.detail == detail
        }) {
            return;
        }
        self.events.push(WebviewEvent {
            webview_id,
            name: name.to_string(),
            detail: detail.to_string(),
        });
    }

    pub fn contains(&self, webview_id: u32, name: &str, detail: Option<&str>) -> bool {
        self.events.iter().any(|event| {
            event.webview_id == webview_id
                && event.name == name
                && detail.is_none_or(|expected| event.detail.contains(expected))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_views_late_callback_cannot_complete_the_next_test() {
        let mut observations = WebviewObservations::new();
        observations.record(15, "will-navigate", "about:blank");
        observations.clear();
        // The previous view can finish after its close request was posted.
        observations.record(15, "dom-ready", "about:blank");
        assert!(!observations.contains(16, "dom-ready", None));
        observations.record(16, "dom-ready", "views://test-harness/index.html");
        assert!(observations.contains(16, "dom-ready", None));
    }

    #[test]
    fn a_later_event_cannot_erase_the_navigation_commit_url() {
        let mut observations = WebviewObservations::new();
        observations.record(18, "did-commit-navigation", "views://zig/index.html");
        // A delayed bridge message belongs to an earlier document load.
        observations.record(18, "dom-ready", "views://test-harness/index.html");
        assert!(observations.contains(18, "did-commit-navigation", Some("views://zig")));
    }

    #[test]
    fn another_views_same_event_cannot_replace_the_target_evidence() {
        let mut observations = WebviewObservations::new();
        observations.record(18, "did-commit-navigation", "views://zig/index.html");
        observations.record(
            17,
            "did-commit-navigation",
            "views://test-harness/index.html",
        );
        assert!(observations.contains(18, "did-commit-navigation", Some("views://zig")));
        assert!(!observations.contains(17, "did-commit-navigation", Some("views://zig")));
    }

    #[test]
    fn a_late_same_event_from_an_old_document_cannot_erase_observed_evidence() {
        let mut observations = WebviewObservations::new();
        observations.record(18, "did-commit-navigation", "views://zig/index.html");
        observations.record(
            18,
            "did-commit-navigation",
            "views://test-harness/index.html",
        );
        assert!(observations.contains(18, "did-commit-navigation", Some("views://zig")));
        observations.record(18, "did-commit-navigation", "views://zig/index.html");
        assert_eq!(
            observations.events.len(),
            2,
            "duplicate callbacks need no extra storage"
        );
    }

    #[test]
    fn navigation_requires_the_target_event_and_url_together() {
        let mut observations = WebviewObservations::new();
        observations.record(
            18,
            "did-commit-navigation",
            "views://test-harness/index.html",
        );
        observations.record(18, "will-navigate", "views://zig/index.html");
        assert!(!observations.contains(18, "did-commit-navigation", Some("views://zig")));
        observations.record(18, "did-commit-navigation", "views://zig/index.html");
        assert!(observations.contains(18, "did-commit-navigation", Some("views://zig")));
    }

    #[test]
    fn reset_removes_prior_evidence_for_the_same_view() {
        let mut observations = WebviewObservations::new();
        observations.record(18, "did-navigate", "views://zig/index.html");
        observations.clear();
        assert!(!observations.contains(18, "did-navigate", Some("views://zig")));
    }
}
