package main

import "core:testing"

empty_test_sim :: proc(seed: u32 = 1) -> ^Sim {
	sim := new(Sim)
	sim.rng = seed
	return sim
}

@(test)
sand_displaces_water :: proc(t: ^testing.T) {
	sim := empty_test_sim()
	defer free(sim)
	for x in 9 ..= 11 {
		set_cell(sim, x, 12, .Stone)
	}
	set_cell(sim, 9, 11, .Stone)
	set_cell(sim, 11, 11, .Stone)
	set_cell(sim, 10, 11, .Water)
	set_cell(sim, 10, 10, .Sand)

	sim_step(sim)

	testing.expect_value(t, material_at(sim, 10, 11), Material.Sand)
	testing.expect_value(t, material_at(sim, 10, 10), Material.Water)
}

@(test)
water_sinks_below_oil :: proc(t: ^testing.T) {
	sim := empty_test_sim()
	defer free(sim)
	for x in 9 ..= 11 {
		set_cell(sim, x, 12, .Stone)
	}
	set_cell(sim, 9, 11, .Stone)
	set_cell(sim, 11, 11, .Stone)
	set_cell(sim, 10, 11, .Oil)
	set_cell(sim, 10, 10, .Water)

	sim_step(sim)

	testing.expect_value(t, material_at(sim, 10, 11), Material.Water)
	testing.expect_value(t, material_at(sim, 10, 10), Material.Oil)
}

@(test)
water_extinguishes_fire :: proc(t: ^testing.T) {
	sim := empty_test_sim()
	defer free(sim)
	for x in 9 ..= 12 {
		set_cell(sim, x, 11, .Stone)
	}
	set_cell(sim, 12, 10, .Stone)
	set_cell(sim, 10, 10, .Fire)
	set_cell(sim, 11, 10, .Water)

	sim_step(sim)

	testing.expect_value(t, material_at(sim, 10, 10), Material.Empty)
}

@(test)
reset_is_deterministic :: proc(t: ^testing.T) {
	first := new(Sim)
	second := new(Sim)
	defer free(first)
	defer free(second)
	sim_reset(first, 0xA11CE)
	sim_reset(second, 0xA11CE)

	equal := first.occupied == second.occupied && first.rng == second.rng
	for index in 0 ..< CELL_COUNT {
		if first.cells[index] != second.cells[index] {
			equal = false
			break
		}
	}
	testing.expect(t, equal)
}

@(test)
paint_command_rasterizes_continuous_stroke :: proc(t: ^testing.T) {
	sim := empty_test_sim(0xB055)
	defer free(sim)
	apply_paint_command(
		sim,
		Paint_Command {
			from_x = 0.1,
			from_y = 0.5,
			to_x = 0.9,
			to_y = 0.5,
			radius = 2,
			material = .Stone,
		},
	)
	testing.expectf(t, sim.occupied > 900, "expected a continuous painted stroke, got %d cells", sim.occupied)
}
