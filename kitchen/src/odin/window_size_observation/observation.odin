package window_size_observation

Size :: struct { width, height: f64 }
Result :: enum { Waiting, Reached, Timed_Out }
Observation :: struct {
	target: Size,
	tolerance: f64,
	timeout_ns: i64,
	first, last: Size,
	has_observation: bool,
}

// Observe one submitted resize, including intermediate animation frames.
// The caller reads elapsed time after the frame query, so a slow read cannot
// turn a result arriving after the deadline into a passing assertion.
observe :: proc(state: ^Observation, size: Size, elapsed_ns: i64) -> Result {
	if !state.has_observation {
		state.first = size
		state.has_observation = true
	}
	state.last = size
	if elapsed_ns <= state.timeout_ns &&
	   abs(size.width - state.target.width) <= state.tolerance &&
	   abs(size.height - state.target.height) <= state.tolerance {
		return .Reached
	}
	if elapsed_ns >= state.timeout_ns {
		return .Timed_Out
	}
	return .Waiting
}
