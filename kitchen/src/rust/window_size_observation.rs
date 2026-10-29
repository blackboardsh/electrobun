use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct WindowSizeObservation {
    pub elapsed: Duration,
    pub first: (f64, f64),
    pub last: (f64, f64),
    pub reads: usize,
}

// Observe the one submitted resize without issuing it again: a request that
// never takes effect must still fail, even when the window manager is busy.
pub fn wait_for_window_size(
    width: f64,
    height: f64,
    tolerance: f64,
    timeout: Duration,
    read_size: impl FnMut() -> Result<(f64, f64), String>,
) -> Result<WindowSizeObservation, String> {
    let started = Instant::now();
    wait_for_window_size_with_clock(
        width,
        height,
        tolerance,
        timeout,
        read_size,
        || started.elapsed(),
        thread::sleep,
    )
}

fn describe_size(size: Option<(f64, f64)>) -> String {
    size.map(|(width, height)| format!("{width}x{height}"))
        .unwrap_or_else(|| "unavailable".to_string())
}

fn wait_for_window_size_with_clock(
    width: f64,
    height: f64,
    tolerance: f64,
    timeout: Duration,
    mut read_size: impl FnMut() -> Result<(f64, f64), String>,
    elapsed: impl Fn() -> Duration,
    mut sleep: impl FnMut(Duration),
) -> Result<WindowSizeObservation, String> {
    let mut first = None;
    let mut last = None;
    let mut reads = 0;
    loop {
        let observed = read_size().map_err(|error| format!(
            "reading window size while waiting for {width}x{height} after {:?}: {error}; first observed {}; last observed {}",
            elapsed(), describe_size(first), describe_size(last),
        ))?;
        let elapsed = elapsed();
        let first_observed = *first.get_or_insert(observed);
        last = Some(observed);
        reads += 1;
        if elapsed <= timeout
            && (observed.0 - width).abs() <= tolerance
            && (observed.1 - height).abs() <= tolerance
        {
            return Ok(WindowSizeObservation {
                elapsed,
                first: first_observed,
                last: observed,
                reads,
            });
        }
        let remaining = timeout.saturating_sub(elapsed);
        if remaining.is_zero() {
            return Err(format!(
                "timed out waiting for window size {width}x{height} (tolerance {tolerance}) after {elapsed:?}: first observed {}; last observed {} ({reads} observations)",
                describe_size(first), describe_size(last),
            ));
        }
        sleep(Duration::from_millis(25).min(remaining));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn accepts_completion_after_the_old_fixed_sleep() {
        let clock = Cell::new(Duration::ZERO);
        let result = wait_for_window_size_with_clock(
            600.0,
            500.0,
            24.0,
            Duration::from_secs(3),
            || {
                Ok(if clock.get() < Duration::from_millis(175) {
                    (420.0, 308.0)
                } else {
                    (600.0, 500.0)
                })
            },
            || clock.get(),
            |delay| clock.set(clock.get() + delay),
        )
        .unwrap();
        assert_eq!(result.elapsed, Duration::from_millis(175));
        assert_eq!(result.first, (420.0, 308.0));
        assert_eq!(result.last, (600.0, 500.0));
        assert_eq!(result.reads, 8);
    }

    #[test]
    fn requires_both_dimensions_with_the_existing_tolerance() {
        let clock = Cell::new(Duration::ZERO);
        let result = wait_for_window_size_with_clock(
            600.0,
            500.0,
            24.0,
            Duration::from_secs(3),
            || {
                Ok(if clock.get() < Duration::from_millis(200) {
                    (600.0, 308.0)
                } else {
                    (624.0, 476.0)
                })
            },
            || clock.get(),
            |delay| clock.set(clock.get() + delay),
        )
        .unwrap();
        assert_eq!(result.elapsed, Duration::from_millis(200));
        assert_eq!(result.last, (624.0, 476.0));
    }

    #[test]
    fn resize_that_never_completes_fails_at_the_deadline() {
        let clock = Cell::new(Duration::ZERO);
        let error = wait_for_window_size_with_clock(
            600.0,
            500.0,
            24.0,
            Duration::from_millis(60),
            || Ok((420.0, 308.0)),
            || clock.get(),
            |delay| clock.set(clock.get() + delay),
        )
        .unwrap_err();
        assert_eq!(clock.get(), Duration::from_millis(60));
        for expected in [
            "600x500",
            "tolerance 24",
            "after 60ms",
            "first observed 420x308",
            "last observed 420x308",
        ] {
            assert!(error.contains(expected), "missing {expected}: {error}");
        }
    }

    #[test]
    fn read_failure_is_not_retried() {
        let clock = Cell::new(Duration::ZERO);
        let mut reads = 0;
        let error = wait_for_window_size_with_clock(
            320.0,
            240.0,
            24.0,
            Duration::from_secs(3),
            || {
                reads += 1;
                if reads == 1 {
                    Ok((600.0, 500.0))
                } else {
                    Err("window closed".to_string())
                }
            },
            || clock.get(),
            |delay| clock.set(clock.get() + delay),
        )
        .unwrap_err();
        assert_eq!(reads, 2);
        assert_eq!(clock.get(), Duration::from_millis(25));
        for expected in [
            "320x240",
            "window closed",
            "first observed 600x500",
            "last observed 600x500",
        ] {
            assert!(error.contains(expected), "missing {expected}: {error}");
        }
    }

    #[test]
    fn rejects_a_matching_read_that_returns_after_the_deadline() {
        let clock = Cell::new(Duration::ZERO);
        let error = wait_for_window_size_with_clock(
            600.0,
            500.0,
            24.0,
            Duration::from_secs(3),
            || {
                clock.set(Duration::from_secs(4));
                Ok((600.0, 500.0))
            },
            || clock.get(),
            |_| panic!("late completion must not sleep or retry"),
        )
        .unwrap_err();
        assert!(error.contains("after 4s"), "{error}");
        assert!(error.contains("last observed 600x500"), "{error}");
    }

    #[test]
    fn completed_resize_returns_without_sleeping() {
        let result = wait_for_window_size_with_clock(
            320.0,
            240.0,
            24.0,
            Duration::from_secs(3),
            || Ok((320.0, 240.0)),
            || Duration::ZERO,
            |_| panic!("already completed resize must not sleep"),
        )
        .unwrap();
        assert_eq!(result.elapsed, Duration::ZERO);
        assert_eq!(result.reads, 1);
    }

    #[test]
    fn non_finite_observations_cannot_complete_resize() {
        for observed in [(f64::NAN, 500.0), (600.0, f64::INFINITY)] {
            let clock = Cell::new(Duration::ZERO);
            assert!(wait_for_window_size_with_clock(
                600.0,
                500.0,
                24.0,
                Duration::from_millis(50),
                || Ok(observed),
                || clock.get(),
                |delay| clock.set(clock.get() + delay),
            )
            .is_err());
        }
    }
}
