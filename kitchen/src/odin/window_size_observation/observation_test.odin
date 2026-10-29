package window_size_observation

import "core:testing"
import "core:time"

@(test)
resize_delayed_beyond_old_sleep :: proc(t: ^testing.T) {
	state := Observation{target = {600, 500}, tolerance = 24, timeout_ns = 3 * i64(time.Second)}
	testing.expect_value(t, observe(&state, {420, 308}, 150 * i64(time.Millisecond)), Result.Waiting)
	testing.expect_value(t, observe(&state, {510, 410}, 175 * i64(time.Millisecond)), Result.Waiting)
	testing.expect_value(t, observe(&state, {600, 500}, 200 * i64(time.Millisecond)), Result.Reached)
	testing.expect_value(t, state.first.width, 420)
	testing.expect_value(t, state.last.height, 500)
}

@(test)
unchanged_or_partially_matching_resize_times_out :: proc(t: ^testing.T) {
	state := Observation{target = {600, 500}, tolerance = 24, timeout_ns = 3 * i64(time.Second)}
	testing.expect_value(t, observe(&state, {420, 308}, 0), Result.Waiting)
	testing.expect_value(t, observe(&state, {600, 308}, 2999 * i64(time.Millisecond)), Result.Waiting)
	testing.expect_value(t, observe(&state, {600, 308}, 3000 * i64(time.Millisecond)), Result.Timed_Out)
}

@(test)
matching_read_after_deadline_is_rejected :: proc(t: ^testing.T) {
	state := Observation{target = {600, 500}, tolerance = 24, timeout_ns = 3 * i64(time.Second)}
	testing.expect_value(t, observe(&state, {600, 500}, state.timeout_ns + 1), Result.Timed_Out)
}

@(test)
shrink_preserves_tolerance_and_frame_is_exact :: proc(t: ^testing.T) {
	shrink := Observation{target = {320, 240}, tolerance = 24, timeout_ns = 3 * i64(time.Second)}
	testing.expect_value(t, observe(&shrink, {600, 500}, 0), Result.Waiting)
	testing.expect_value(t, observe(&shrink, {345, 240}, 100 * i64(time.Millisecond)), Result.Waiting)
	testing.expect_value(t, observe(&shrink, {344, 264}, 200 * i64(time.Millisecond)), Result.Reached)
	frame := Observation{target = {640, 480}, tolerance = 0, timeout_ns = 3 * i64(time.Second)}
	testing.expect_value(t, observe(&frame, {639, 480}, 0), Result.Waiting)
	testing.expect_value(t, observe(&frame, {640, 480}, 250 * i64(time.Millisecond)), Result.Reached)
}
