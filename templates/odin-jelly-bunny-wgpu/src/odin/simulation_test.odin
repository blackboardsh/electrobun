package main

import "core:testing"

test_approx :: proc(actual, expected, tolerance: f32) -> bool {
	return abs(actual - expected) <= tolerance
}

@(test)
reset_is_deterministic :: proc(t: ^testing.T) {
	first, second: Jelly_Sim
	sim_reset(&first)

	second.nodes[BODY_CENTER].position = {99, -42}
	second.constraint_count = 1
	second.selected = TAIL
	sim_reset(&second)

	testing.expect_value(t, first.nodes, second.nodes)
	testing.expect_value(t, first.constraints, second.constraints)
	testing.expect_value(t, first.constraint_count, second.constraint_count)
	testing.expect_value(t, first.constraint_count, 40)
	testing.expect_value(t, first.selected, -1)

	for node in first.nodes {
		testing.expect(t, node.position == node.previous, "reset must start every Verlet node at rest")
	}
}

@(test)
constraints_keep_a_stable_bunny_shape :: proc(t: ^testing.T) {
	sim: Jelly_Sim
	sim_reset(&sim)
	params := default_jelly_params()
	pointer: Pointer_Snapshot
	aspect: f32 = 1.5

	for _ in 0 ..< 720 {
		sim_update(&sim, params, pointer, aspect)
	}

	max_relative_error: f32
	for i in 0 ..< sim.constraint_count {
		constraint := sim.constraints[i]
		distance := v_length(v_sub(
			sim.nodes[constraint.b].position,
			sim.nodes[constraint.a].position,
		))
		relative_error := abs(distance - constraint.rest) / max(constraint.rest, 0.0001)
		max_relative_error = max(max_relative_error, relative_error)
	}

	testing.expectf(
		t,
		max_relative_error < 0.20,
		"settled constraint error was too large: %.4f",
		max_relative_error,
	)
	testing.expect(
		t,
		v_length(v_sub(sim.nodes[BODY_RIGHT].position, sim.nodes[BODY_LEFT].position)) > 0.35,
		"body cage collapsed",
	)
	testing.expect(
		t,
		v_length(v_sub(sim.nodes[HEAD_RIGHT].position, sim.nodes[HEAD_LEFT].position)) > 0.24,
		"head cage collapsed",
	)

	for node in sim.nodes {
		finite := node.position.x == node.position.x && node.position.y == node.position.y
		in_bounds :=
			node.position.x >= -aspect - 0.001 &&
			node.position.x <= aspect + 0.001 &&
			node.position.y >= -1.001 &&
			node.position.y <= 1.001
		testing.expect(t, finite, "simulation produced a NaN position")
		testing.expect(t, in_bounds, "simulation node escaped the viewport")
	}

	instances: [MAX_RENDER_PARTS * FLOATS_PER_INSTANCE]f32
	part_count := pack_bunny(&sim, instances[:], aspect)
	testing.expect_value(t, part_count, 23)
}

@(test)
pointer_grab_release_retains_throw_velocity :: proc(t: ^testing.T) {
	sim: Jelly_Sim
	sim_reset(&sim)
	params := default_jelly_params()
	params.paused = true
	aspect: f32 = 1.5

	press := Pointer_Snapshot{x = 0.5, y = 0.58, down = true, pressed = true}
	sim_update(&sim, params, press, aspect)
	testing.expect_value(t, sim.selected, BODY_CENTER)

	move := Pointer_Snapshot{x = 0.65, y = 0.40, down = true}
	sim_update(&sim, params, move, aspect)
	testing.expect(t, test_approx(sim.nodes[BODY_CENTER].position.x, 0.45, 0.0001))
	testing.expect(t, sim.nodes[BODY_CENTER].position.x > sim.nodes[BODY_CENTER].previous.x)

	release := Pointer_Snapshot{x = 0.70, y = 0.35, released = true}
	sim_update(&sim, params, release, aspect)
	throw_velocity := v_sub(
		sim.nodes[BODY_CENTER].position,
		sim.nodes[BODY_CENTER].previous,
	)

	testing.expect_value(t, sim.selected, -1)
	testing.expect(t, test_approx(sim.nodes[BODY_CENTER].position.x, 0.60, 0.0001))
	testing.expect(t, test_approx(sim.nodes[BODY_CENTER].position.y, 0.30, 0.0001))
	testing.expect(t, throw_velocity.x > 0.10, "release must retain horizontal drag velocity")
	testing.expect(t, throw_velocity.y > 0.05, "release must retain vertical drag velocity")
}

@(test)
corner_collision_reflects_both_velocity_axes :: proc(t: ^testing.T) {
	aspect: f32 = 1.5
	node := Node{
		position = {-2.0, -2.0},
		previous = {-1.8, -1.7},
	}
	collide_node(&node, aspect, 0.5)
	velocity := v_sub(node.position, node.previous)

	testing.expect(t, test_approx(node.position.x, -1.465, 0.0001))
	testing.expect(t, test_approx(node.position.y, -0.965, 0.0001))
	testing.expect(t, velocity.x > 0, "left-wall collision must reflect x velocity")
	testing.expect(t, velocity.y > 0, "floor collision must reflect y velocity")
}
