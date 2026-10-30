package fullscreen_restoration

import "core:testing"
import "core:time"

before :: Snapshot{frame = {140, 100, 640, 420}, work_area = {0, 25, 1920, 1015}}

@(test)
exit_waits_for_frame_and_work_area :: proc(t: ^testing.T) {
	state := Observation{before = before, timeout_ns = i64(time.Second)}
	sample := before
	sample.fullscreen = true
	testing.expect_value(t, observe(&state, sample, 0), Result.Waiting)
	sample.fullscreen = false
	sample.frame.height = 1080
	testing.expect_value(t, observe(&state, sample, 50 * i64(time.Millisecond)), Result.Waiting)
	sample.frame = before.frame
	sample.work_area.height += 1
	testing.expect_value(t, observe(&state, sample, 100 * i64(time.Millisecond)), Result.Waiting)
	sample.work_area = before.work_area
	testing.expect_value(t, observe(&state, sample, 175 * i64(time.Millisecond)), Result.Restored)
	testing.expect_value(t, state.first.fullscreen, true)
	testing.expect_value(t, state.last, before)
}

@(test)
frame_tolerance_is_one_pixel_and_work_area_is_exact :: proc(t: ^testing.T) {
	deltas := []Rect{{1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {0, 0, 0, 1}}
	for delta in deltas {
		state := Observation{before = before, timeout_ns = i64(time.Second)}
		sample := before
		sample.frame = {before.frame.x + delta.x, before.frame.y + delta.y,
		                before.frame.width + delta.width, before.frame.height + delta.height}
		testing.expect_value(t, observe(&state, sample, 0), Result.Restored)
		sample.frame = {before.frame.x + delta.x * 1.01, before.frame.y + delta.y * 1.01,
		                before.frame.width + delta.width * 1.01, before.frame.height + delta.height * 1.01}
		testing.expect_value(t, observe(&state, sample, 0), Result.Waiting)
		sample.frame = before.frame
		sample.work_area = {before.work_area.x + delta.x, before.work_area.y + delta.y,
		                    before.work_area.width + delta.width, before.work_area.height + delta.height}
		testing.expect_value(t, observe(&state, sample, state.timeout_ns), Result.Timed_Out)
	}
}

@(test)
non_restoration_and_late_success_fail :: proc(t: ^testing.T) {
	state := Observation{before = before, timeout_ns = i64(time.Second)}
	sample := before
	sample.work_area.y += 1
	testing.expect_value(t, observe(&state, sample, state.timeout_ns), Result.Timed_Out)
	testing.expect_value(t, observe(&state, before, state.timeout_ns + 1), Result.Timed_Out)
}

@(test)
read_error_cannot_pass_or_replace_previous_observations :: proc(t: ^testing.T) {
	state := Observation{before = before, timeout_ns = i64(time.Second)}
	sample := before
	sample.fullscreen = true
	testing.expect_value(t, observe(&state, sample, 0), Result.Waiting)
	testing.expect_value(t, observe(&state, before, 25 * i64(time.Millisecond), true), Result.Read_Failed)
	testing.expect_value(t, state.first, sample)
	testing.expect_value(t, state.last, sample)
}
