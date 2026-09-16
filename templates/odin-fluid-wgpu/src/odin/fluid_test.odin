package main

import "core:math"
import "core:testing"

new_test_sim :: proc(columns, rows: int) -> ^Sim {
	sim := new(Sim)
	sim.columns = columns
	sim.rows = rows
	return sim
}

seeded_fields_match :: proc(a, b: ^Sim) -> bool {
	if a.columns != b.columns || a.rows != b.rows || a.clock != b.clock {
		return false
	}
	for y in 0 ..< a.rows {
		for x in 0 ..< a.columns {
			i := grid_index(x, y)
			if a.u[i] != b.u[i] || a.v[i] != b.v[i] ||
			   a.dye_r[i] != b.dye_r[i] || a.dye_g[i] != b.dye_g[i] || a.dye_b[i] != b.dye_b[i] {
				return false
			}
		}
	}
	return true
}

total_dye :: proc(sim: ^Sim) -> f32 {
	total: f32
	for y in 0 ..< sim.rows {
		for x in 0 ..< sim.columns {
			i := grid_index(x, y)
			total += sim.dye_r[i] + sim.dye_g[i] + sim.dye_b[i]
		}
	}
	return total
}

total_speed :: proc(sim: ^Sim) -> f32 {
	total: f32
	for y in 0 ..< sim.rows {
		for x in 0 ..< sim.columns {
			i := grid_index(x, y)
			total += abs(sim.u[i]) + abs(sim.v[i])
		}
	}
	return total
}

velocity_divergence :: proc(sim: ^Sim) -> f32 {
	total: f32
	inv_columns := 1.0 / f32(sim.columns)
	inv_rows := 1.0 / f32(sim.rows)
	for y in 1 ..< sim.rows - 1 {
		for x in 1 ..< sim.columns - 1 {
			du := (sim.u[grid_index(x + 1, y)] - sim.u[grid_index(x - 1, y)]) * inv_columns
			dv := (sim.v[grid_index(x, y + 1)] - sim.v[grid_index(x, y - 1)]) * inv_rows
			total += abs(du + dv)
		}
	}
	return total
}

velocity_is_finite_and_bounded :: proc(sim: ^Sim, limit: f32) -> bool {
	for y in 0 ..< sim.rows {
		for x in 0 ..< sim.columns {
			i := grid_index(x, y)
			u, v := sim.u[i], sim.v[i]
			if math.is_nan(u) || math.is_inf(u) || abs(u) > limit ||
			   math.is_nan(v) || math.is_inf(v) || abs(v) > limit {
				return false
			}
		}
	}
	return true
}

@(test)
fluid_initialization_is_deterministic :: proc(t: ^testing.T) {
	a := new_test_sim(96, 72)
	b := new_test_sim(96, 72)
	defer free(a)
	defer free(b)

	sim_reset(a, 0)
	sim_reset(b, 0)

	testing.expect(t, seeded_fields_match(a, b), "fixed seed inputs must produce identical fields")
	testing.expect(t, total_dye(a) > 0, "reset must seed a visible fluid field")
}

@(test)
ink_brush_injects_dye_and_velocity :: proc(t: ^testing.T) {
	sim := new_test_sim(64, 48)
	defer free(sim)
	sim_clear(sim)

	apply_input(sim, Fluid_Input{
		x = 0.52,
		y = 0.48,
		dx = 0.08,
		dy = -0.04,
		tool = .Ink,
		hue = 0.31,
		radius = 6,
		force = 0.72,
	}, 1)

	testing.expect(t, total_dye(sim) > 0, "ink brush must inject dye")
	testing.expect(t, total_speed(sim) > 0, "a dragged ink brush must inject velocity")
}

@(test)
projection_reduces_divergence :: proc(t: ^testing.T) {
	sim := new_test_sim(72, 54)
	defer free(sim)
	sim_clear(sim)

	for y in 1 ..< sim.rows - 1 {
		for x in 1 ..< sim.columns - 1 {
			i := grid_index(x, y)
			sim.u[i] = math.sin(f32(x) * 0.19) * math.cos(f32(y) * 0.11)
			sim.v[i] = math.cos(f32(x) * 0.07) * math.sin(f32(y) * 0.23)
		}
	}

	before := velocity_divergence(sim)
	project_velocity(sim.u[:], sim.v[:], sim.pressure[:], sim.divergence[:], sim.columns, sim.rows)
	after := velocity_divergence(sim)

	testing.expectf(t, before > 0 && after < before, "projection must reduce divergence: before=%.6f after=%.6f", before, after)
	testing.expect(t, velocity_is_finite_and_bounded(sim, 4), "projected velocities must remain finite and bounded")
}
