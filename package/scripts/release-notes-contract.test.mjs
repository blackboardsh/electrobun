import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflowUrl = new URL("../../.github/workflows/release.yml", import.meta.url);
const workflow = readFileSync(workflowUrl, "utf8");

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
	const releaseJob = job(source, "release");
	const createRelease = namedStep(releaseJob, "Create Release");

	assert.match(createRelease, /^        uses: softprops\/action-gh-release@v2$/m);
	assert.match(createRelease, /^          generate_release_notes: true$/m);
	assert.doesNotMatch(createRelease, /^          body(?:_path)?:/m);
	assert.match(
		createRelease,
		/^          tag_name: \$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}$/m,
	);
	assert.match(createRelease, /^            artifacts\/\*\*\/\*\.tar\.gz$/m);
	assert.match(
		createRelease,
		/^          prerelease: \$\{\{ github\.event\.inputs\.prerelease \|\| contains\(github\.ref_name, '-beta'\) \|\| contains\(github\.event\.inputs\.tag, '-beta'\) \}\}$/m,
	);

	assert.match(
		releaseJob,
		/^      - name: Verify release notes configuration\n        run: node package\/scripts\/release-notes-contract\.test\.mjs$/m,
	);
	assert.ok(
		releaseJob.indexOf("- name: Verify release notes configuration") <
			releaseJob.indexOf("- name: Create Release"),
		"release notes verification must run before release creation",
	);
	assert.match(job(source, "npm-publish"), /^    needs: \[release\]$/m);
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
