package fullscreen_restoration

Rect :: struct { x, y, width, height: f64 }
Snapshot :: struct {
	fullscreen: bool,
	frame, work_area: Rect,
}
Result :: enum { Waiting, Restored, Timed_Out, Read_Failed }
Observation :: struct {
	before: Snapshot,
	timeout_ns: i64,
	first, last: Snapshot,
	has_observation: bool,
}

// A cleared fullscreen style bit precedes restoration of the desktop. The
// caller supplies elapsed time after all reads; late observations cannot pass.
observe :: proc(state: ^Observation, sample: Snapshot, elapsed_ns: i64, read_failed := false) -> Result {
	if read_failed {
		return .Read_Failed
	}
	if !state.has_observation {
		state.first = sample
		state.has_observation = true
	}
	state.last = sample
	frame := sample.frame
	before := state.before.frame
	if elapsed_ns <= state.timeout_ns && !sample.fullscreen &&
	   abs(frame.x - before.x) <= 1 && abs(frame.y - before.y) <= 1 &&
	   abs(frame.width - before.width) <= 1 && abs(frame.height - before.height) <= 1 &&
	   sample.work_area == state.before.work_area {
		return .Restored
	}
	if elapsed_ns >= state.timeout_ns {
		return .Timed_Out
	}
	return .Waiting
}
