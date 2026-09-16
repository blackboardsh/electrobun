import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
	new URL("../../.github/workflows/release.yml", import.meta.url),
	"utf8",
).replace(/\r\n/g, "\n");

function job(source, name) {
	const marker = `  ${name}:\n`;
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `missing ${name} job`);
	const remaining = source.slice(start + marker.length);
	const next = remaining.search(/^  [a-zA-Z0-9_-]+:\s*$/m);
	return next === -1 ? remaining : remaining.slice(0, next);
}

function namedStep(source, name) {
	const marker = `      - name: ${name}\n`;
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `missing ${name} step`);
	const remaining = source.slice(start + marker.length);
	const next = remaining.search(/^      - /m);
	return next === -1 ? remaining : remaining.slice(0, next);
}

function stepsUsingPattern(source, actionPattern) {
	const uses = [...source.matchAll(/^      - uses: ([^\n]+)$/gm)].filter(
		([, action]) => actionPattern.test(action),
	);
	return uses.map((match) => {
		const marker = `${match[0]}\n`;
		const start = match.index;
		const remaining = source.slice(start + marker.length);
		const next = remaining.search(/^      - /m);
		return (
			next === -1
				? source.slice(start)
				: source.slice(start, start + marker.length + next)
		);
	});
}

function validatePublicationContract(source) {
	const header = source.slice(0, source.indexOf("jobs:\n"));
	assert.match(
		header,
		/permissions:\n  contents: read\n\n$/,
		"workflow permissions must default to read-only contents",
	);
	const checkoutSteps = stepsUsingPattern(source, /^actions\/checkout@/);
	assert.equal(checkoutSteps.length, 5, "every release job checkout is audited");
	for (const checkout of checkoutSteps) {
		assert.match(checkout, /^      - uses: actions\/checkout@\S+$/m);
		assert.match(
			checkout,
			/^          persist-credentials: false$/m,
			"checkout credentials must not persist into later release steps",
		);
		assert.equal(
			(checkout.match(/persist-credentials:/g) ?? []).length,
			1,
			"each checkout must declare its credential policy exactly once",
		);
	}

	assert.match(
		source,
		/^concurrency:\n  group: electrobun-release\n  cancel-in-progress: false\n  queue: max$/m,
		"all tags must share one non-cancelling publication lane",
	);
	assert.doesNotMatch(source, /group: electrobun-release-\$\{\{/);

	const build = job(source, "build");
	const release = job(source, "release");
	const npmPublish = job(source, "npm-publish");
	const npmAcceptance = job(source, "npm-acceptance");
	const mutablePublication = job(source, "publish-templates");
	const reconcile = namedStep(
		release,
		"Reuse or prepare a draft Electrobun release",
	);
	const npmPreflight = namedStep(
		release,
		"Preflight npm channel monotonicity",
	);
	const releaseNodeSetup = namedStep(
		release,
		"Set up Node for npm integrity",
	);
	const createDraft = namedStep(release, "Create or refresh draft Release");
	const verifyDraft = namedStep(release, "Verify staged draft release");
	const finalizeDraft = namedStep(release, "Finalize verified draft release");
	const publicGate = namedStep(release, "Require a complete public release");
	const npmGate = namedStep(npmPublish, "Check existing npm bootstrap");
	const npmPublication = namedStep(npmPublish, "Publish npm bootstrap");
	const npmVerification = namedStep(
		npmPublish,
		"Verify published npm bootstrap",
	);
	const publicAcceptance = namedStep(
		npmAcceptance,
		"Accept public single-package npm bootstrap on ${{ matrix.platform }}",
	);
	const kitchenDownload = namedStep(
		mutablePublication,
		"Download Kitchen artifacts",
	);
	const kitchenPublication = namedStep(
		mutablePublication,
		"Publish Kitchen artifacts to R2",
	);
	const mutableNpmGate = namedStep(
		mutablePublication,
		"Recheck npm channel before mutable publication",
	);
	const templateValidation = namedStep(
		mutablePublication,
		"Validate template publisher",
	);
	const templatePublication = namedStep(
		mutablePublication,
		"Publish latest template channel to R2",
	);
	const kitchenBuild = namedStep(build, "Build Kitchen");
	const appleCertificate = namedStep(build, "Install Apple Certificate");

	assert.equal(
		(source.match(/^    permissions:$/gm) ?? []).length,
		3,
		"only explicitly audited jobs may override workflow permissions",
	);
	assert.doesNotMatch(build, /^    permissions:$/m);
	assert.match(
		release,
		/^    permissions:\n      contents: write\n\n    steps:$/m,
	);
	assert.match(
		npmPublish,
		/^    permissions:\n      contents: read\n\n    steps:$/m,
	);
	assert.match(
		npmAcceptance,
		/^    permissions:\n      contents: read\n    strategy:$/m,
	);
	assert.doesNotMatch(mutablePublication, /^    permissions:$/m);
	assert.doesNotMatch(source, /secrets\s*\[|toJSON\(secrets\)/);
	assert.match(appleCertificate, /^        if: matrix\.platform == 'darwin'$/m);
	for (const secret of ["MACOS_CERTIFICATE", "MACOS_CERTIFICATE_PWD"]) {
		assert.match(
			appleCertificate,
			new RegExp(
				`^          ${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}$`,
				"m",
			),
		);
		assert.equal(
			(source.match(new RegExp(`secrets\\.${secret}\\b`, "g")) ?? []).length,
			1,
		);
	}
	for (const secret of [
		"ELECTROBUN_DEVELOPER_ID",
		"ELECTROBUN_APPLEID",
		"ELECTROBUN_APPLEIDPASS",
		"ELECTROBUN_TEAMID",
	]) {
		assert.match(
			kitchenBuild,
			new RegExp(
				`^          ${secret}: \\$\\{\\{ matrix\\.platform == 'darwin' && secrets\\.${secret} \\|\\| '' \\}\\}$`,
				"m",
			),
			`${secret} must reach only the macOS Kitchen build`,
		);
		assert.equal(
			(source.match(new RegExp(`secrets\\.${secret}\\b`, "g")) ?? []).length,
			1,
			`${secret} must not be exposed by another step`,
		);
	}
	assert.equal(
		(kitchenBuild.match(/secrets\./g) ?? []).length,
		4,
		"Kitchen may receive only its four Darwin-guarded signing secrets",
	);

	assert.match(
		reconcile,
		/--json tagName,databaseId,isDraft,isPrerelease,assets/,
	);
	assert.match(reconcile, /"\$is_draft" == "false"/);
	assert.match(
		reconcile,
		/"\$is_prerelease" != "\$EXPECTED_PRERELEASE"/,
	);
	assert.match(
		reconcile,
		/node package\/scripts\/verify-release-assets\.mjs[\s\S]*?--actual "\$existing_assets"/,
		"a public release cannot be reused before its downloaded assets verify",
	);
	assert.match(reconcile, /gh release edit "\$RELEASE_TAG"[\s\S]*?--draft=true/);
	assert.match(
		reconcile,
		/repos\/\$GITHUB_REPOSITORY\/releases\/\$release_id\/assets/,
		"draft retries must remove stale and unexpected assets before re-upload",
	);
	assert.match(reconcile, /echo "upload=true" >> "\$GITHUB_OUTPUT"/);
	assert.match(reconcile, /echo "upload=false" >> "\$GITHUB_OUTPUT"/);
	assert.match(
		npmPreflight,
		/^          RELEASE_PACKAGE_JSON: npm\/electrobun\/package\.json$/m,
	);
	assert.match(npmPreflight, /node package\/scripts\/verify-release-version\.mjs/);
	assert.match(npmPreflight, /node npm\/scripts\/check-published-bootstrap\.mjs/);
	assert.match(npmPreflight, /--tag "\$NPM_DIST_TAG"/);
	assert.match(releaseNodeSetup, /^        uses: actions\/setup-node@v6$/m);
	assert.match(releaseNodeSetup, /^          node-version: '18'$/m);
	assert.ok(
		release.indexOf("- name: Set up Node for npm integrity") <
			release.indexOf("- name: Preflight npm channel monotonicity"),
		"npm pack integrity must use the same pinned Node runtime as publication",
	);
	assert.ok(
		release.indexOf("- name: Preflight npm channel monotonicity") <
			release.indexOf("- name: Reuse or prepare a draft Electrobun release"),
		"the npm rollback gate must precede every GitHub release mutation",
	);
	assert.match(
		reconcile,
		/Public release \$RELEASE_TAG is incomplete or inconsistent; refusing to mutate it/,
	);
	assert.match(
		reconcile,
		/if \[\[ "\$is_draft" != "true" \]\]; then/,
		"only an existing draft may enter the clear-and-refresh path",
	);
	assert.ok(
		reconcile.indexOf('if [[ "$is_draft" != "true" ]]') <
			reconcile.indexOf('gh release edit "$RELEASE_TAG"'),
		"a public release must fail before any edit",
	);

	assert.match(
		createDraft,
		/^        if: steps\.release-state\.outputs\.upload == 'true'$/m,
	);
	assert.match(createDraft, /^        uses: softprops\/action-gh-release@v2$/m);
	assert.match(createDraft, /^          draft: true$/m);
	assert.match(
		createDraft,
		/^          prerelease: \$\{\{ steps\.release-type\.outputs\.prerelease == 'true' \}\}$/m,
	);
	assert.match(createDraft, /^          fail_on_unmatched_files: true$/m);
	assert.match(createDraft, /^          overwrite_files: true$/m);

	assert.match(
		verifyDraft,
		/\.isDraft == true and \.isPrerelease == \$prerelease/,
	);
	assert.match(verifyDraft, /gh release download "\$RELEASE_TAG"/);
	assert.match(
		verifyDraft,
		/node package\/scripts\/verify-release-assets\.mjs[\s\S]*?--actual "\$staged_assets"/,
	);
	assert.match(finalizeDraft, /gh release edit "\$RELEASE_TAG"/);
	assert.match(finalizeDraft, /--draft=false/);
	assert.match(finalizeDraft, /--prerelease="\$EXPECTED_PRERELEASE"/);
	assert.match(
		publicGate,
		/\.isDraft == false and \.isPrerelease == \$prerelease/,
	);
	assert.ok(
		release.indexOf("- name: Verify staged draft release") <
			release.indexOf("- name: Finalize verified draft release"),
		"asset verification must precede finalization",
	);
	assert.ok(
		release.indexOf("- name: Finalize verified draft release") <
			release.indexOf("- name: Require a complete public release"),
		"the release job must prove the final public state",
	);
	assert.doesNotMatch(
		release,
		/R2_|upload-kitchen-artifacts|kitchen-artifacts/,
		"the release job must not mutate Kitchen channels before the npm gate",
	);

	assert.match(npmPublish, /^    needs: \[release\]$/m);
	assert.match(npmGate, /check-published-bootstrap\.mjs/);
	assert.match(
		npmGate,
		/--tag "\$\{\{ steps\.release-type\.outputs\.dist-tag \}\}"/,
	);
	assert.ok(
		npmPublish.indexOf("- name: Check existing npm bootstrap") <
			npmPublish.indexOf("- name: Publish npm bootstrap"),
		"the monotonic npm gate must precede npm publication",
	);
	assert.match(
		npmPublication,
		/^        if: steps\.npm-state\.outputs\.exists != 'true'$/m,
	);
	assert.match(npmVerification, /check-published-bootstrap\.mjs/);
	assert.match(npmVerification, /grep -Fxq 'exists=true'/);
	assert.match(npmVerification, /^        timeout-minutes: 10$/m);
	assert.match(npmVerification, /^          max_attempts=19$/m);
	assert.match(
		npmVerification,
		/for \(\(attempt = 1; attempt <= max_attempts; attempt \+= 1\)\); do/,
		"post-publish verification must retry the entire exact registry check",
	);
	assert.match(
		npmVerification,
		/: > "\$published_state"[\s\S]*?if node npm\/scripts\/check-published-bootstrap\.mjs[\s\S]*?grep -Fxq 'exists=true'/,
		"every retry must discard stale output and rerun both integrity and dist-tag checks",
	);
	assert.match(
		npmVerification,
		/--manifest npm\/electrobun\/package\.json[\s\S]*?--tag "\$\{\{ steps\.release-type\.outputs\.dist-tag \}\}"[\s\S]*?--output "\$published_state"/,
		"every retry must validate the release manifest, exact channel, and fresh state file",
	);
	assert.match(
		npmVerification,
		/if \(\( attempt == max_attempts \)\); then[\s\S]*?exit 1/,
		"registry propagation retries must fail closed at a finite limit",
	);
	assert.match(npmVerification, /^            sleep 10$/m);
	assert.doesNotMatch(npmVerification, /while true/);
	assert.ok(
		npmPublish.indexOf("- name: Publish npm bootstrap") <
			npmPublish.indexOf("- name: Verify published npm bootstrap"),
		"the registry identity and dist-tag must be re-read after publication",
	);
	assert.doesNotMatch(npmPublish, /R2_|upload-kitchen-artifacts/);

	assert.match(npmAcceptance, /^    needs: \[npm-publish\]$/m);
	assert.match(npmAcceptance, /^    permissions:\n      contents: read$/m);
	assert.match(npmAcceptance, /^      fail-fast: false$/m);
	for (const [runner, platform] of [
		["macos-14", "macos-arm64"],
		["ubuntu-24.04", "linux-x64"],
		["ubuntu-24.04-arm", "linux-arm64"],
		["windows-2025", "windows-x64"],
	]) {
		assert.match(
			npmAcceptance,
			new RegExp(`- os: ${runner}\\n            platform: ${platform}`),
		);
	}
	assert.match(
		npmAcceptance,
		/^      - name: Verify exact published npm acceptance version\n        id: release-type$/m,
	);
	assert.match(publicAcceptance, /accept-published-bootstrap\.mjs/);
	assert.match(
		publicAcceptance,
		/--version "\$\{\{ steps\.release-type\.outputs\.version \}\}"/,
	);
	assert.match(
		publicAcceptance,
		/--release-tag "\$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}"/,
	);
	assert.match(
		publicAcceptance,
		/--dist-tag "\$\{\{ steps\.release-type\.outputs\.dist-tag \}\}"/,
	);
	assert.match(
		publicAcceptance,
		/--repository "\$\{\{ github\.repository \}\}"/,
	);
	assert.match(
		publicAcceptance,
		/--platform "\$\{\{ matrix\.platform \}\}"/,
	);
	assert.doesNotMatch(npmAcceptance, /updater|update-flow|test-updater/i);
	assert.doesNotMatch(npmAcceptance, /R2_|upload-kitchen-artifacts|publish-templates/);

	assert.match(mutablePublication, /^    needs: \[npm-acceptance\]$/m);
	assert.match(
		mutablePublication,
		/^      - name: Verify matching npm bootstrap version\n        id: release-type$/m,
	);
	assert.match(kitchenDownload, /^        uses: actions\/download-artifact@v7$/m);
	assert.match(kitchenDownload, /^          pattern: kitchen-\*$/m);
	assert.match(mutableNpmGate, /check-published-bootstrap\.mjs/);
	assert.match(
		mutableNpmGate,
		/--tag "\$\{\{ steps\.release-type\.outputs\.dist-tag \}\}"/,
	);
	assert.match(mutableNpmGate, /grep -Fxq 'exists=true'/);
	assert.match(
		templateValidation,
		/node --test scripts\/publish-templates\.test\.mjs/,
	);
	assert.match(kitchenPublication, /upload-kitchen-artifacts\.ts kitchen-artifacts/);
	assert.ok(
		mutablePublication.indexOf(
			"- name: Recheck npm channel before mutable publication",
		) < mutablePublication.indexOf("- name: Validate template publisher"),
		"a job-only rerun must recheck the live npm channel before publisher validation",
	);
	assert.ok(
		mutablePublication.indexOf("- name: Validate template publisher") <
			mutablePublication.indexOf("- name: Publish Kitchen artifacts to R2"),
		"template publisher validation must pass before the first mutable R2 write",
	);
	assert.ok(
		mutablePublication.indexOf("- name: Publish Kitchen artifacts to R2") <
			mutablePublication.indexOf("- name: Publish latest template channel to R2"),
		"Kitchen must publish only after the npm gate and before templates",
	);
	assert.match(templatePublication, /node scripts\/publish-templates\.mjs/);
}

test("serializes releases, verifies drafts, and gates mutable channels", () => {
	validatePublicationContract(workflow);
});

test("contract rejects tag-local concurrency and premature public uploads", () => {
	assert.throws(
		() =>
			validatePublicationContract(
				workflow.replace(
					"group: electrobun-release",
					"group: electrobun-release-${{ github.ref_name }}",
				),
			),
		{ code: "ERR_ASSERTION" },
	);
	assert.throws(
		() =>
			validatePublicationContract(
				workflow.replace("          draft: true", "          draft: false"),
			),
		{ code: "ERR_ASSERTION" },
	);
});

test("contract rejects broad credentials and cross-platform Apple secrets", () => {
	assert.throws(
		() =>
			validatePublicationContract(
				workflow.replace(
					"permissions:\n  contents: read",
					"permissions:\n  contents: write",
				),
			),
		{ code: "ERR_ASSERTION" },
	);
	assert.throws(
		() =>
			validatePublicationContract(
				workflow.replace("          persist-credentials: false\n", ""),
			),
		{ code: "ERR_ASSERTION" },
	);
	assert.throws(
		() =>
			validatePublicationContract(
				workflow.replace(
					"${{ matrix.platform == 'darwin' && secrets.ELECTROBUN_TEAMID || '' }}",
					"${{ secrets.ELECTROBUN_TEAMID || '' }}",
				),
			),
		{ code: "ERR_ASSERTION" },
	);
});

test("contract rejects single-shot or unbounded post-publish verification", () => {
	assert.throws(
		() =>
			validatePublicationContract(
				workflow.replace("          max_attempts=19", "          max_attempts=1"),
			),
		{ code: "ERR_ASSERTION" },
	);
	assert.throws(
		() =>
			validatePublicationContract(
				workflow.replace(
					"          for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do",
					"          while true; do",
				),
			),
		{ code: "ERR_ASSERTION" },
	);
});

test("contract rejects mutable Kitchen publication before the npm gate", () => {
	const kitchenStep = `      - name: Publish Kitchen artifacts to R2\n        run: hutch scripts/upload-kitchen-artifacts.ts kitchen-artifacts\n\n`;
	assert.throws(
		() =>
			validatePublicationContract(
				workflow.replace("  npm-publish:\n", `${kitchenStep}  npm-publish:\n`),
			),
		{ code: "ERR_ASSERTION" },
	);
});
