use std::time::Instant;

struct WebviewEvent {
    webview_id: u32,
    name: String,
    detail: String,
    elapsed_ms: u128,
}

// Closing a Windows window posts WM_CLOSE; callbacks already in flight can
// arrive after the next test starts. Keep each view and event's evidence
// separate instead of sharing one counter and one last-detail string.
pub struct WebviewObservations {
    events: Vec<WebviewEvent>,
    started: Option<Instant>,
}

impl WebviewObservations {
    pub const fn new() -> Self {
        Self {
            events: Vec::new(),
            started: None,
        }
    }

    pub fn clear(&mut self) {
        self.events.clear();
        self.started = Some(Instant::now());
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
            elapsed_ms: self.started.get_or_insert_with(Instant::now).elapsed().as_millis(),
        });
    }

    /// Keep timeout evidence about the failing view, including earlier commits
    /// and errors. Bound the dump so a data URL cannot flood unattended logs.
    pub fn history(&self, webview_id: u32) -> String {
        let mut history = String::new();
        for event in self.events.iter()
            .filter(|event| event.webview_id == webview_id)
            .take(32)
        {
            use std::fmt::Write;
            let detail: String = event.detail.chars().take(240).collect();
            let _ = write!(history, "\n  +{}ms {} {:?}", event.elapsed_ms, event.name, detail);
        }
        if history.is_empty() {
            "\n  (no events for this view)".to_string()
        } else {
            history
        }
    }

    pub fn contains(&self, webview_id: u32, name: &str, detail: Option<&str>) -> bool {
        self.events.iter().any(|event| {
            event.webview_id == webview_id
                && event.name == name
                && detail.is_none_or(|expected| event.detail.contains(expected))
        })
    }

    pub fn contains_exact(&self, webview_id: u32, name: &str, detail: &str) -> bool {
        self.events.iter().any(|event| {
            event.webview_id == webview_id && event.name == name && event.detail == detail
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_html_data_url_containing_the_redirect_target_is_not_completed_navigation() {
        let mut observations = WebviewObservations::new();
        let target = "views://test-harness/index.html?loadHtml=rust-rendered";
        observations.record(18, "did-navigate", &format!(
            "data:text/html,<script>location.href='{target}'</script>"
        ));
        // Substring searches remain available for events carrying JSON, but
        // cannot establish that the requested navigation actually completed.
        assert!(observations.contains(18, "did-navigate", Some(target)));
        assert!(!observations.contains_exact(18, "did-navigate", target));
        observations.record(19, "did-navigate", target);
        observations.record(18, "will-navigate", target);
        assert!(!observations.contains_exact(18, "did-navigate", target));
        observations.record(18, "did-navigate", target);
        assert!(observations.contains_exact(18, "did-navigate", target));
    }

    #[test]
    fn failure_history_preserves_order_and_filters_other_views() {
        let mut observations = WebviewObservations::new();
        observations.record(18, "will-navigate", "views://zig/index.html");
        observations.record(19, "did-navigate", "other-view");
        observations.record(18, "load-failed", "views://zig/index.html");
        let history = observations.history(18);
        assert!(history.find("will-navigate").unwrap() < history.find("load-failed").unwrap());
        assert!(!history.contains("other-view"));
        assert!(observations.history(20).contains("no events"));
    }

    #[test]
    fn failure_history_bounds_unicode_details_and_event_count() {
        let mut observations = WebviewObservations::new();
        for index in 0..40 {
            observations.record(18, &format!("event-{index}"), &"✓".repeat(500));
        }
        let history = observations.history(18);
        assert_eq!(history.lines().filter(|line| line.contains(" event-")).count(), 32);
        assert_eq!(history.matches('✓').count(), 240 * 32);
        assert!(!history.contains("event-32"));
    }

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
