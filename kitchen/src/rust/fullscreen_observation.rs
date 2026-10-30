use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug)]
pub struct FullscreenSnapshot {
    pub fullscreen: bool,
    pub frame: [f64; 4],
    pub work_area: [f64; 4],
}

impl FullscreenSnapshot {
    fn restored(self, original: Self) -> bool {
        !self.fullscreen
            && self
                .frame
                .iter()
                .zip(original.frame)
                .all(|(value, expected)| {
                    value.is_finite() && expected.is_finite() && (value - expected).abs() <= 1.0
                })
            && self
                .work_area
                .iter()
                .zip(original.work_area)
                .all(|(value, expected)| value.is_finite() && *value == expected)
    }
}

// The fullscreen style bit clears before AppKit restores the window and Space.
// Observe the one exit request through restoration before the caller closes it.
pub fn wait_for_fullscreen_restoration(
    original: FullscreenSnapshot,
    timeout: Duration,
    read: impl FnMut() -> Result<FullscreenSnapshot, String>,
) -> Result<(), String> {
    let started = Instant::now();
    wait_with_clock(original, timeout, read, || started.elapsed(), thread::sleep)
}

fn wait_with_clock(
    original: FullscreenSnapshot,
    timeout: Duration,
    mut read: impl FnMut() -> Result<FullscreenSnapshot, String>,
    elapsed: impl Fn() -> Duration,
    mut sleep: impl FnMut(Duration),
) -> Result<(), String> {
    let mut first = None;
    let mut last = None;
    loop {
        let observed = read().map_err(|error| format!(
            "reading fullscreen restoration failed after {:?}: {error}; original={original:?}, first={first:?}, last={last:?}", elapsed(),
        ))?;
        let elapsed = elapsed();
        first.get_or_insert(observed);
        last = Some(observed);
        if elapsed <= timeout && observed.restored(original) {
            println!("[kitchen rust] fullscreen restored after {elapsed:?}: original={original:?}, first={first:?}, last={last:?}");
            return Ok(());
        }
        let remaining = timeout.saturating_sub(elapsed);
        if remaining.is_zero() {
            return Err(format!(
                "fullscreen restoration timed out after {elapsed:?} (limit {timeout:?}): original={original:?}, first={first:?}, last={last:?}",
            ));
        }
        sleep(Duration::from_millis(25).min(remaining));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const ORIGINAL: FullscreenSnapshot = FullscreenSnapshot {
        fullscreen: false,
        frame: [140.0, 100.0, 640.0, 448.0],
        work_area: [0.0, 24.0, 1920.0, 1056.0],
    };

    #[test]
    fn cleared_style_bit_and_restored_frame_still_wait_for_work_area() {
        let clock = Cell::new(Duration::ZERO);
        wait_with_clock(
            ORIGINAL,
            Duration::from_secs(5),
            || {
                let mut observed = ORIGINAL;
                if clock.get() < Duration::from_millis(200) {
                    observed.work_area[1] = 0.0;
                }
                Ok(observed)
            },
            || clock.get(),
            |delay| clock.set(clock.get() + delay),
        )
        .unwrap();
        assert_eq!(clock.get(), Duration::from_millis(200));
    }

    #[test]
    fn requires_false_state_complete_frame_and_exact_work_area() {
        assert!(!FullscreenSnapshot {
            fullscreen: true,
            ..ORIGINAL
        }
        .restored(ORIGINAL));
        for index in 0..4 {
            let mut observed = ORIGINAL;
            observed.frame[index] += 1.0;
            assert!(observed.restored(ORIGINAL));
            observed.frame[index] += 0.01;
            assert!(!observed.restored(ORIGINAL));
            observed = ORIGINAL;
            observed.work_area[index] += 0.01;
            assert!(!observed.restored(ORIGINAL));
        }
    }

    #[test]
    fn missing_restoration_fails_at_deadline() {
        let clock = Cell::new(Duration::ZERO);
        let error = wait_with_clock(
            ORIGINAL,
            Duration::from_millis(60),
            || {
                Ok(FullscreenSnapshot {
                    frame: [0.0; 4],
                    ..ORIGINAL
                })
            },
            || clock.get(),
            |delay| clock.set(clock.get() + delay),
        )
        .unwrap_err();
        assert_eq!(clock.get(), Duration::from_millis(60));
        assert!(error.contains("timed out after 60ms"), "{error}");
    }

    #[test]
    fn rejects_restoration_returning_after_deadline() {
        let clock = Cell::new(Duration::ZERO);
        let error = wait_with_clock(
            ORIGINAL,
            Duration::from_millis(60),
            || {
                clock.set(Duration::from_millis(61));
                Ok(ORIGINAL)
            },
            || clock.get(),
            |_| panic!("late success must fail immediately"),
        )
        .unwrap_err();
        assert!(error.contains("timed out after 61ms"), "{error}");
    }

    #[test]
    fn read_error_is_not_retried() {
        let mut reads = 0;
        let error = wait_with_clock(
            ORIGINAL,
            Duration::from_secs(5),
            || {
                reads += 1;
                Err("display read failed".to_string())
            },
            || Duration::ZERO,
            |_| panic!("read errors must fail immediately"),
        )
        .unwrap_err();
        assert_eq!(reads, 1);
        assert!(error.contains("display read failed"), "{error}");
    }
}
