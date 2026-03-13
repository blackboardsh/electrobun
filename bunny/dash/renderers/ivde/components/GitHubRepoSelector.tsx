import {
	For,
	type JSXElement,
	Show,
	createEffect,
	createSignal,
	onMount,
} from "solid-js";
import {
	type GitHubOrganization,
	type GitHubRepository,
	githubService,
} from "../services/githubService";

interface GitHubRepoSelectorProps {
	onSelectRepository: (
		repo: GitHubRepository,
		branch?: string,
		isEmptyRepo?: boolean,
	) => void;
	selectedRepo?: GitHubRepository | null;
	selectedBranch?: string | null;
}

export const GitHubRepoSelector = (
	props: GitHubRepoSelectorProps,
): JSXElement => {
	const [repositories, setRepositories] = createSignal<GitHubRepository[]>([]);
	const [organizations, setOrganizations] = createSignal<GitHubOrganization[]>(
		[],
	);
	const [selectedOrg, setSelectedOrg] = createSignal<string | null>(null);
	const [searchQuery, setSearchQuery] = createSignal("");
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [sortBy, setSortBy] = createSignal<"updated" | "name" | "stars">(
		"updated",
	);
	const [filterType, setFilterType] = createSignal<"all" | "owner" | "member">(
		"all",
	);
	const [showBranches, setShowBranches] = createSignal<GitHubRepository | null>(
		null,
	);
	const [branches, setBranches] = createSignal<
		Array<{ name: string; commit: { sha: string }; protected: boolean }>
	>([]);

	onMount(() => {
		loadRepositories();
		loadOrganizations();
	});

	// Check if the search query is an owner/repo pattern
	const isOwnerRepoPattern = (query: string): { owner: string; repo: string } | null => {
		const trimmed = query.trim();
		// Match patterns like "owner/repo" or "https://github.com/owner/repo"
		const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+?)(?:\.git)?$/i);
		if (urlMatch) {
			return { owner: urlMatch[1], repo: urlMatch[2] };
		}
		const simpleMatch = trimmed.match(/^([^\/\s]+)\/([^\/\s]+)$/);
		if (simpleMatch) {
			return { owner: simpleMatch[1], repo: simpleMatch[2] };
		}
		return null;
	};

	const loadRepositories = async () => {
		if (!githubService.isConnected()) {
			setError("GitHub not connected");
			return;
		}

		setLoading(true);
		setError(null);

		try {
			let repos: GitHubRepository[];

			// Check if search query is an owner/repo pattern (works in any mode)
			const ownerRepo = isOwnerRepoPattern(searchQuery());
			if (ownerRepo) {
				try {
					const repo = await githubService.fetchRepository(ownerRepo.owner, ownerRepo.repo);
					repos = [repo];
				} catch (err) {
					// If direct fetch fails, fall back to search
					console.log("Direct repo fetch failed, falling back to search:", err);
					repos = [];
				}
			} else if (selectedOrg() === "public") {
				// Search public repositories - use search query if provided, otherwise search for popular repos
				const query = searchQuery().trim() || "stars:>100 created:>2020-01-01"; // Default to popular recent repos
				const result = await githubService.searchRepositories(query, {
					sort:
						sortBy() === "name" ? "updated" : (sortBy() as "updated" | "stars"), // GitHub search API doesn't support name sorting
					per_page: 50,
					includeUserFilter: false, // Search all public repositories, not just user's repos
				});
				repos = result.items;
			} else if (selectedOrg() && selectedOrg() !== "") {
				repos = await githubService.fetchOrganizationRepositories(
					selectedOrg()!,
					{
						sort:
							sortBy() === "stars" || sortBy() === "name"
								? "updated"
								: (sortBy() as "created" | "updated" | "pushed"),
						per_page: 50,
					},
				);
			} else if (searchQuery().trim()) {
				// Search user's accessible repositories
				const result = await githubService.searchRepositories(
					searchQuery().trim(),
					{
						includeUserFilter: true, // This will add the user filter automatically
					},
				);
				repos = result.items;
			} else {
				repos = await githubService.fetchUserRepositories({
					sort:
						sortBy() === "stars" || sortBy() === "name"
							? "updated"
							: (sortBy() as "created" | "updated" | "pushed"),
					type: filterType(),
					per_page: 50,
				});
			}

			// Sort repositories
			repos.sort((a, b) => {
				switch (sortBy()) {
					case "name":
						return a.name.localeCompare(b.name);
					case "stars":
						return b.stargazers_count - a.stargazers_count;
					default:
						return (
							new Date(b.updated_at).getTime() -
							new Date(a.updated_at).getTime()
						);
				}
			});

			setRepositories(repos);
		} catch (err) {
			console.error("Error loading repositories:", err);
			setError(
				err instanceof Error ? err.message : "Failed to load repositories",
			);
		} finally {
			setLoading(false);
		}
	};

	const loadOrganizations = async () => {
		if (!githubService.isConnected()) return;

		try {
			const orgs = await githubService.fetchOrganizations();
			setOrganizations(orgs);
		} catch (err) {
			console.error("Error loading organizations:", err);
		}
	};

	const loadBranches = async (repo: GitHubRepository) => {
		try {
			const repoBranches = await githubService.fetchRepositoryBranches(
				repo.owner.login,
				repo.name,
			);

			let defaultBranch: string;
			let isEmptyRepo = false;

			// If the repo has no branches (empty repo), add a synthetic "main (create)" branch
			if (repoBranches.length === 0) {
				setBranches([
					{
						name: "main",
						commit: { sha: "" },
						protected: false,
					},
				]);
				defaultBranch = "main";
				isEmptyRepo = true;
			} else {
				setBranches(repoBranches);
				// Use the repo's default branch, or the first branch if no default is set
				defaultBranch = repo.default_branch || repoBranches[0].name;
			}

			// Auto-select the default branch BEFORE showing branches
			// This ensures props update before the UI renders
			props.onSelectRepository(repo, defaultBranch, isEmptyRepo);

			// Show branches after selection is set
			setShowBranches(repo);
		} catch (err) {
			console.error("Error loading branches:", err);
			setError("Failed to load branches");
		}
	};

	// Auto-reload when filters change
	createEffect(() => {
		// Track these signals to trigger reload when they change
		selectedOrg();
		sortBy();
		filterType();
		loadRepositories();
	});

	// Debounced search
	createEffect(() => {
		const query = searchQuery();
		const timeoutId = setTimeout(() => {
			if (query !== searchQuery()) return; // Query changed during timeout
			loadRepositories();
		}, 500);

		return () => clearTimeout(timeoutId);
	});

	const formatDate = (dateString: string) => {
		return new Date(dateString).toLocaleDateString();
	};

	const truncateDescription = (description: string | null, maxLength = 120) => {
		if (!description) return description;
		if (description.length <= maxLength) return description;
		return `${description.substring(0, maxLength).trim()}...`;
	};

	const handleRepoSelect = (repo: GitHubRepository) => {
		if (showBranches() === repo) {
			setShowBranches(null);
			return;
		}
		// Don't mark the repo as selected, just load branches
		// We'll only set selection when a branch is explicitly chosen
		loadBranches(repo);
	};

	const handleBranchSelect = (repo: GitHubRepository, branch: string) => {
		// Check if this is an empty repo (branch has no commit SHA)
		const selectedBranch = branches().find((b) => b.name === branch);
		const isEmptyRepo = selectedBranch?.commit.sha === "";

		props.onSelectRepository(repo, branch, isEmptyRepo);
		// Keep branch selector open so user can switch between branches
	};

	if (!githubService.isConnected()) {
		return (
			<div style="padding: 20px; text-align: center; color: #999;">
				<div style="margin-bottom: 12px;">GitHub not connected</div>
				<div style="font-size: 11px;">
					Connect your GitHub account in workspace settings to browse
					repositories.
				</div>
			</div>
		);
	}

	return (
		<div style="display: flex; flex-direction: column; height: 100%;">
			{/* Search and Filters */}
			<div style="padding: 12px; border-bottom: 1px solid #333; background: #2b2b2b;">
				<div style="display: flex; gap: 8px; margin-bottom: 8px;">
					<input
						type="text"
						placeholder="Search or enter owner/repo..."
						value={searchQuery()}
						onInput={(e) => setSearchQuery(e.currentTarget.value)}
						style="flex: 1; background: #1a1a1a; border: 1px solid #555; color: #d9d9d9; padding: 6px 8px; border-radius: 4px; font-size: 11px;"
					/>
					<select
						value={sortBy()}
						onChange={(e) => setSortBy(e.currentTarget.value as any)}
						style="background: #1a1a1a; border: 1px solid #555; color: #d9d9d9; padding: 6px 8px; border-radius: 4px; font-size: 11px;"
					>
						<option value="updated">Recently Updated</option>
						<option value="name">Name</option>
						<option value="stars">Stars</option>
					</select>
				</div>

				<div style="display: flex; gap: 8px;">
					<select
						value={selectedOrg() || ""}
						onChange={(e) => setSelectedOrg(e.currentTarget.value || null)}
						style="flex: 1; background: #1a1a1a; border: 1px solid #555; color: #d9d9d9; padding: 6px 8px; border-radius: 4px; font-size: 11px;"
					>
						<option value="">Your repositories</option>
						<option value="public">Public repositories</option>
						<For each={organizations()}>
							{(org) => <option value={org.login}>{org.login}</option>}
						</For>
					</select>

					<Show when={!selectedOrg() || selectedOrg() === ""}>
						<select
							value={filterType()}
							onChange={(e) => setFilterType(e.currentTarget.value as any)}
							style="background: #1a1a1a; border: 1px solid #555; color: #d9d9d9; padding: 6px 8px; border-radius: 4px; font-size: 11px;"
						>
							<option value="all">All</option>
							<option value="owner">Owner</option>
							<option value="member">Member</option>
						</select>
					</Show>
				</div>
			</div>

			{/* Error Display */}
			<Show when={error()}>
				<div style="padding: 12px; background: #4a1a1a; color: #ff6b6b; font-size: 11px; border-bottom: 1px solid #333;">
					{error()}
				</div>
			</Show>

			{/* Loading State */}
			<Show when={loading()}>
				<div style="padding: 20px; text-align: center; color: #999; font-size: 11px;">
					Loading repositories...
				</div>
			</Show>

			{/* Repository List */}
			<Show when={!loading() && repositories().length > 0}>
				<div style="flex: 1; overflow-y: auto;">
					<For each={repositories()}>
						{(repo) => (
							<div>
								{/* Repository Row */}
								<div
									onClick={() => handleRepoSelect(repo)}
									style={{
										padding: "12px",
										"border-bottom": "1px solid #2a2a2a",
										cursor: "pointer",
										background:
											props.selectedRepo?.id === repo.id && props.selectedBranch
												? "#1a4a6b"
												: "transparent",
									}}
									onMouseEnter={(e) =>
										(e.currentTarget.style.background =
											props.selectedRepo?.id === repo.id && props.selectedBranch
												? "#1a4a6b"
												: "#333")
									}
									onMouseLeave={(e) =>
										(e.currentTarget.style.background =
											props.selectedRepo?.id === repo.id && props.selectedBranch
												? "#1a4a6b"
												: "transparent")
									}
								>
									<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
										<div style="font-size: 12px; font-weight: 500; color: #d9d9d9;">
											{repo.name}
										</div>
										<Show when={repo.private}>
											<span style="background: #4a4a4a; color: #999; padding: 2px 6px; border-radius: 3px; font-size: 9px;">
												PRIVATE
											</span>
										</Show>
										<Show when={repo.fork}>
											<span style="background: #4a4a4a; color: #999; padding: 2px 6px; border-radius: 3px; font-size: 9px;">
												FORK
											</span>
										</Show>
									</div>

									<Show when={repo.description}>
										<div style="font-size: 10px; color: #999; margin-bottom: 6px;">
											{truncateDescription(repo.description)}
										</div>
									</Show>

									<div style="display: flex; align-items: center; gap: 12px; font-size: 10px; color: #666;">
										<Show when={repo.language}>
											<span>{repo.language}</span>
										</Show>
										<span>⭐ {repo.stargazers_count}</span>
										<span>Updated {formatDate(repo.updated_at)}</span>
									</div>
								</div>

								{/* Branch Selection */}
								<Show when={showBranches()?.id === repo.id}>
									<div style="background: #1a1a1a; border-bottom: 1px solid #2a2a2a;">
										<div style="padding: 8px 12px; font-size: 10px; color: #999; border-bottom: 1px solid #333;">
											Select branch to clone:
										</div>
										<div>
											{/* Branch list container - no height restriction, expands naturally */}
											<For each={branches()}>
												{(branch) => {
													const isDefault = branch.name === repo.default_branch;
													const isEmpty = branch.commit.sha === ""; // Empty repo indicator
													const isSelected = () =>
														props.selectedRepo?.id === repo.id &&
														props.selectedBranch === branch.name;

													return (
														<div
															onClick={() =>
																handleBranchSelect(repo, branch.name)
															}
															style={{
																padding: "8px 24px",
																cursor: "pointer",
																"font-size": "11px",
																color: isSelected() ? "#ffffff" : "#d9d9d9",
																"border-bottom": "1px solid #2a2a2a",
																background: isSelected()
																	? "#0969da"
																	: "transparent",
																"font-weight":
																	isSelected() || isDefault ? "500" : "normal",
															}}
															onMouseEnter={(e) => {
																if (!isSelected())
																	e.currentTarget.style.background = "#333";
															}}
															onMouseLeave={(e) => {
																if (!isSelected()) {
																	e.currentTarget.style.background =
																		"transparent";
																}
															}}
														>
															<div style="display: flex; align-items: center; gap: 8px;">
																<Show when={isSelected()}>
																	<span style="color: #ffffff;">✓</span>
																</Show>
																<span>{branch.name}</span>
																<Show when={isEmpty}>
																	<span
																		style={{
																			background: isSelected()
																				? "rgba(255,255,255,0.2)"
																				: "#4a4a6b",
																			color: isSelected()
																				? "#ffffff"
																				: "#6b9cff",
																			padding: "1px 4px",
																			"border-radius": "2px",
																			"font-size": "9px",
																		}}
																	>
																		CREATE
																	</span>
																</Show>
																<Show when={isDefault && !isEmpty}>
																	<span
																		style={{
																			background: isSelected()
																				? "rgba(255,255,255,0.2)"
																				: "#4a6741",
																			color: isSelected()
																				? "#ffffff"
																				: "#8bc34a",
																			padding: "1px 4px",
																			"border-radius": "2px",
																			"font-size": "9px",
																		}}
																	>
																		DEFAULT
																	</span>
																</Show>
																<Show when={branch.protected}>
																	<span
																		style={{
																			background: isSelected()
																				? "rgba(255,255,255,0.2)"
																				: "#6b4a1a",
																			color: isSelected()
																				? "#ffffff"
																				: "#ffa500",
																			padding: "1px 4px",
																			"border-radius": "2px",
																			"font-size": "9px",
																		}}
																	>
																		PROTECTED
																	</span>
																</Show>
															</div>
														</div>
													);
												}}
											</For>
										</div>
										{/* Close scrollable container */}
									</div>
								</Show>
							</div>
						)}
					</For>
				</div>
			</Show>

			{/* Empty State */}
			<Show when={!loading() && repositories().length === 0}>
				<div style="padding: 20px; text-align: center; color: #999; font-size: 11px;">
					<Show
						when={searchQuery().trim()}
						fallback={<div>No repositories found</div>}
					>
						<div>No repositories found matching "{searchQuery()}"</div>
					</Show>
				</div>
			</Show>
		</div>
	);
};
