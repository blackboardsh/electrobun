import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflowUrl = new URL("../../.github/workflows/release.yml", import.meta.url);
const workflow = readFileSync(workflowUrl, "utf8").replace(/\r\n/g, "\n");

function job(source, name) {
	const startMarker = `  ${name}:\n`;
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1, `missing ${name} job`);

	const remaining = source.slice(start + startMarker.length);
	const nextJob = remaining.search(/^  [a-zA-Z0-9_-]+:\s*$/m);
	return nextJob === -1 ? remaining : remaining.slice(0, nextJob);
}

function namedStep(jobSource, name) {
	const startMarker = `      - name: ${name}\n`;
	const start = jobSource.indexOf(startMarker);
	assert.notEqual(start, -1, `missing ${name} step`);

	const remaining = jobSource.slice(start + startMarker.length);
	const nextStep = remaining.search(/^      - /m);
	return nextStep === -1 ? remaining : remaining.slice(0, nextStep);
}

function validateReleaseWorkflow(source) {
	const buildJob = job(source, "build");
	const releaseJob = job(source, "release");
	const npmPublishJob = job(source, "npm-publish");
	const npmAcceptanceJob = job(source, "npm-acceptance");
	const publishTemplatesJob = job(source, "publish-templates");
	const createRelease = namedStep(releaseJob, "Create or refresh draft Release");
	const buildVersionCheck = namedStep(buildJob, "Verify release tag and version");
	const releaseVersionCheck = namedStep(
		releaseJob,
		"Verify release tag and version",
	);
	const npmVersionCheck = namedStep(
		npmPublishJob,
		"Verify matching npm bootstrap version",
	);
	const npmAcceptanceVersionCheck = namedStep(
		npmAcceptanceJob,
		"Verify exact published npm acceptance version",
	);
	const npmAcceptance = namedStep(
		npmAcceptanceJob,
		"Accept public single-package npm bootstrap on ${{ matrix.platform }}",
	);

	for (const versionCheck of [buildVersionCheck, releaseVersionCheck]) {
		assert.match(versionCheck, /^        id: release-type$/m);
		assert.match(
			versionCheck,
			/^          RELEASE_TAG: \$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}$/m,
		);
		assert.match(
			versionCheck,
			/^          RELEASE_PACKAGE_JSON: package\/package\.json$/m,
		);
		assert.match(
			versionCheck,
			/^        run: node package\/scripts\/verify-release-version\.mjs$/m,
		);
	}
	assert.match(npmVersionCheck, /^        id: release-type$/m);
	assert.match(
		npmVersionCheck,
		/^          RELEASE_TAG: \$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}$/m,
	);
	assert.match(
		npmVersionCheck,
		/^          RELEASE_PACKAGE_JSON: npm\/electrobun\/package\.json$/m,
	);
	assert.match(
		npmVersionCheck,
		/^        run: node package\/scripts\/verify-release-version\.mjs$/m,
	);
	assert.match(npmAcceptanceVersionCheck, /^        id: release-type$/m);
	assert.match(
		npmAcceptanceVersionCheck,
		/^          RELEASE_PACKAGE_JSON: npm\/electrobun\/package\.json$/m,
	);
	assert.match(
		npmAcceptanceVersionCheck,
		/^        run: node package\/scripts\/verify-release-version\.mjs$/m,
	);
	assert.ok(
		buildJob.indexOf("- name: Verify release tag and version") <
			buildJob.indexOf("- name: Install Hutch"),
		"release version verification must run before build setup",
	);
	assert.ok(
		releaseJob.indexOf("- name: Verify release tag and version") <
			releaseJob.indexOf("- name: Download Electrobun release artifacts"),
		"release version verification must run before release assembly",
	);
	assert.doesNotMatch(source, /Determine release type/);
	for (const releasePath of [
		buildJob,
		releaseJob,
		npmPublishJob,
		npmAcceptanceJob,
		publishTemplatesJob,
	]) {
		assert.match(
			releasePath,
			/^          ref: \$\{\{ github\.event_name == 'workflow_dispatch' && format\('refs\/tags\/\{0\}', github\.event\.inputs\.tag\) \|\| github\.ref \}\}$/m,
			"manual releases must check out the exact requested tag",
		);
	}

	assert.match(createRelease, /^        uses: softprops\/action-gh-release@v2$/m);
	assert.match(createRelease, /^          generate_release_notes: true$/m);
	assert.match(createRelease, /^          draft: true$/m);
	assert.doesNotMatch(createRelease, /^          body(?:_path)?:/m);
	assert.match(
		createRelease,
		/^          tag_name: \$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}$/m,
	);
	assert.match(createRelease, /^            artifacts\/\*\*\/\*\.tar\.gz$/m);
	assert.match(
		createRelease,
		/^          prerelease: \$\{\{ steps\.release-type\.outputs\.prerelease == 'true' \}\}$/m,
	);

	assert.match(
		releaseJob,
		/^      - name: Verify release notes configuration\n        run: node package\/scripts\/release-notes-contract\.test\.mjs$/m,
	);
	assert.ok(
		releaseJob.indexOf("- name: Verify release notes configuration") <
			releaseJob.indexOf("- name: Create or refresh draft Release"),
		"release notes verification must run before release creation",
	);
	assert.match(npmPublishJob, /^    needs: \[release\]$/m);
	assert.match(npmAcceptanceJob, /^    needs: \[npm-publish\]$/m);
	assert.match(publishTemplatesJob, /^    needs: \[npm-acceptance\]$/m);
	assert.match(npmAcceptance, /accept-published-bootstrap\.mjs/);
	assert.match(
		npmAcceptance,
		/--version "\$\{\{ steps\.release-type\.outputs\.version \}\}"/,
	);
	assert.match(
		npmAcceptance,
		/--platform "\$\{\{ matrix\.platform \}\}"/,
	);
	assert.ok(
		source.indexOf("  npm-publish:\n") <
			source.indexOf("  npm-acceptance:\n") &&
			source.indexOf("  npm-acceptance:\n") <
			source.indexOf("  publish-templates:\n"),
		"public npm acceptance must run after npm publish and before mutable templates",
	);
	assert.match(
		npmPublishJob,
		/^        working-directory: npm\/electrobun$/m,
	);
	assert.match(
		npmPublishJob,
		/^        run: npm publish --access public --tag "\$\{\{ steps\.release-type\.outputs\.dist-tag \}\}"$/m,
	);
}

validateReleaseWorkflow(workflow);
assert.throws(
	() =>
		validateReleaseWorkflow(
			workflow.replace("generate_release_notes: true", "generate_release_notes: false"),
		),
	{ code: "ERR_ASSERTION" },
);
assert.throws(
	() =>
		validateReleaseWorkflow(
			workflow.replace("          prerelease:", "          body: Static release text\n          prerelease:"),
		),
	{ code: "ERR_ASSERTION" },
);

console.log("Release notes workflow contract passed.");
