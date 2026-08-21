package electrobun

import "core:testing"

capture_test_x: f64
capture_test_y: f64
capture_test_width: u32
capture_test_height: u32

capture_region_test_stub :: proc "c" (
	x, y: f64,
	width, height: u32,
	out_rgba: rawptr,
	out_len: u64,
) -> bool {
	capture_test_x = x
	capture_test_y = y
	capture_test_width = width
	capture_test_height = height
	pixels := ([^]u8)(out_rgba)[:int(out_len)]
	for &pixel, index in pixels {
		pixel = u8(index % 251)
	}
	return true
}

capture_region_failure_stub :: proc "c" (
	_: f64,
	_: f64,
	_: u32,
	_: u32,
	_: rawptr,
	_: u64,
) -> bool {
	return false
}

@(test)
capture_region_allocates_rgba_and_floors_origin :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	core.symbols.captureScreenRegion = capture_region_test_stub
	pixels, err := captureScreenRegion(&core, Rect{x = 12.75, y = -3.125, width = 2, height = 3})
	defer if pixels != nil {
		delete(pixels, core.allocator)
	}

	testing.expect_value(t, err, Error.None)
	testing.expect_value(t, len(pixels), 24)
	testing.expect_value(t, capture_test_x, f64(12))
	testing.expect_value(t, capture_test_y, f64(-4))
	testing.expect_value(t, capture_test_width, u32(2))
	testing.expect_value(t, capture_test_height, u32(3))
	testing.expect_value(t, pixels[23], u8(23))
}

@(test)
capture_region_rejects_invalid_dimensions :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	_, zero_err := captureScreenRegion(&core, Rect{width = 0, height = 1})
	_, fractional_err := captureScreenRegion(&core, Rect{width = 1.5, height = 1})
	_, overflow_err := captureScreenRegion(
		&core,
		Rect{width = 4294967295, height = 4294967295},
	)

	testing.expect_value(t, zero_err, Error.InvalidScreenCaptureRegion)
	testing.expect_value(t, fractional_err, Error.InvalidScreenCaptureRegion)
	testing.expect_value(t, overflow_err, Error.InvalidScreenCaptureRegion)
}

@(test)
capture_region_releases_pixels_when_native_capture_fails :: proc(t: ^testing.T) {
	core := Core{allocator = context.allocator}
	core.symbols.captureScreenRegion = capture_region_failure_stub
	pixels, err := captureScreenRegion(&core, Rect{width = 2, height = 3})

	testing.expect(t, pixels == nil)
	testing.expect_value(t, err, Error.ElectrobunCoreFailure)
}
