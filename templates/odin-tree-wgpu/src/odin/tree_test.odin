package main

import "core:math"
import "core:testing"

expect_same_tree :: proc(t: ^testing.T, actual, expected: ^Tree) {
	testing.expect_value(t, actual.branch_count, expected.branch_count)
	testing.expect_value(t, actual.leaf_count, expected.leaf_count)
	testing.expect_value(t, actual.profile, expected.profile)

	for i in 0 ..< actual.branch_count {
		testing.expect(t, actual.branches[i] == expected.branches[i])
	}
	for i in 0 ..< actual.leaf_count {
		testing.expect(t, actual.leaves[i] == expected.leaves[i])
	}
}

point_segment_distance_squared :: proc(point, start, end: Vec3) -> f32 {
	segment := vec_sub(end, start)
	length_squared := vec_dot(segment, segment)
	if length_squared <= 0.0000001 {
		return vec_dot(vec_sub(point, start), vec_sub(point, start))
	}
	t := clamp(vec_dot(vec_sub(point, start), segment) / length_squared, 0, 1)
	closest := vec_add(start, vec_scale(segment, t))
	delta := vec_sub(point, closest)
	return vec_dot(delta, delta)
}

@(test)
same_seed_generates_identical_tree :: proc(t: ^testing.T) {
	first := new(Tree)
	defer free(first)
	second := new(Tree)
	defer free(second)

	params := default_tree_params()
	params.seed = 0xC0FFEE
	params.species = .Silver_Birch
	tree_generate(first, params)
	tree_generate(second, params)

	expect_same_tree(t, first, second)

	params.seed += 1
	tree_generate(second, params)
	testing.expect(t, first.rng != second.rng || first.branches[5] != second.branches[5])
}

@(test)
generated_trees_stay_bounded :: proc(t: ^testing.T) {
	tree := new(Tree)
	defer free(tree)

	species_values := [?]Species{.Field_Oak, .Silver_Birch, .Alpine_Pine}
	seeds := [?]u32{1, 1847, 0xC0FFEE, 0xFFFF_FFFF}
	densities := [?]f32{0, 1}
	for species in species_values {
		for seed in seeds {
			for density in densities {
				params := default_tree_params()
				params.seed = seed
				params.species = species
				params.branching = density
				params.density = density
				tree_generate(tree, params)

				testing.expect(t, tree.branch_count >= 6)
				testing.expect(t, tree.branch_count <= MAX_BRANCHES)
				testing.expect(t, tree.leaf_count > 0)
				testing.expect(t, tree.leaf_count <= MAX_LEAVES)
			}
		}
	}
}

@(test)
branches_attach_to_an_earlier_parent :: proc(t: ^testing.T) {
	tree := new(Tree)
	defer free(tree)
	params := default_tree_params()
	params.branching = 1
	tree_generate(tree, params)

	// The first five records are root flares and record five is the trunk.
	for child_index in 6 ..< tree.branch_count {
		child := tree.branches[child_index]
		connected := false
		for parent_index in 5 ..< child_index {
			parent := tree.branches[parent_index]
			if parent.depth + 1 != child.depth {
				continue
			}
			if point_segment_distance_squared(child.start, parent.start, parent.end) <= 0.0000001 {
				connected = true
				break
			}
		}
		testing.expect(t, connected)
	}
}

@(test)
growth_reveals_instances_monotonically :: proc(t: ^testing.T) {
	tree := new(Tree)
	defer free(tree)
	params := default_tree_params()
	tree_generate(tree, params)

	instances := make([]f32, MAX_INSTANCES * FLOATS_PER_INSTANCE)
	defer delete(instances)
	previous_count := 0
	growth_values := [?]f32{0, 0.05, 0.2, 0.5, 0.75, 0.9, 1}
	for growth in growth_values {
		count := pack_instances(tree, params, instances, 1.5, 4.25, growth)
		testing.expect(t, count >= previous_count)
		testing.expect(t, count <= 1 + tree.branch_count + tree.leaf_count)
		previous_count = count
	}

	testing.expect_value(t, pack_instances(tree, params, instances, 1.5, 4.25, 0), 1)
	testing.expect_value(
		t,
		pack_instances(tree, params, instances, 1.5, 4.25, 1),
		1 + tree.branch_count + tree.leaf_count,
	)
	testing.expect_value(t, smoothstep01(-1), f32(0))
	testing.expect_value(t, smoothstep01(2), f32(1))
}

@(test)
wind_is_grounded_deterministic_and_bounded :: proc(t: ^testing.T) {
	point := Vec3{0.42, 2.1, -0.33}
	clock := f32(3.75)

	testing.expect_value(t, wind_point(point, clock, 0), point)
	testing.expect_value(t, wind_point({0.8, 0, -0.5}, clock, 1), Vec3{0.8, 0, -0.5})

	low := wind_point(point, clock, 0.25)
	high := wind_point(point, clock, 1)
	testing.expect_value(t, high, wind_point(point, clock, 1))
	testing.expect_value(t, high.y, point.y)

	low_delta := vec_sub(low, point)
	high_delta := vec_sub(high, point)
	testing.expect(t, vec_dot(high_delta, high_delta) >= vec_dot(low_delta, low_delta))
	height := clamp(point.y / 3.4, 0, 1)
	max_x_displacement := height * height * 0.255
	testing.expect(t, math.abs(high_delta.x) <= max_x_displacement)
	testing.expect(t, math.abs(high_delta.z) <= max_x_displacement * 0.55)
}
