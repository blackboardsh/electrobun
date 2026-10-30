#!/usr/bin/env node
// Diagnostic counterpart to run.mjs: explicitly tests this checkout and its
// freshly built devkit. Never used as the published-release acceptance test.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../accept-published-template.mjs';
import { validateNativeDevkitManifest } from '../../package/scripts/validate-native-devkit.mjs';
import { templateScenarios, kitchenScenarios, skipReason } from './scenarios.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'ebs-'));
const version = JSON.parse(readFileSync(join(root, 'package/package.json'), 'utf8')).version;
const os = { darwin: 'macos', linux: 'linux', win32: 'win' }[process.platform];
validateNativeDevkitManifest({ coreRoot: join(root, 'package/dist'), expectedVersion: version, expectedTarget: { os, arch: process.arch } });
const pragma = readFileSync(join(root, 'package/hutch.config.ts'), 'utf8').split('\n')[0];
const cli = pragma.match(/cli=(\S+)/)[1];
const hutch = (await run('hutch', ['self', 'path', cli], { cwd: join(root, 'package'), env: { ...process.env, HUTCH_DEFAULT_CLI: cli } })).trim();
const env = { ...process.env, HUTCH_ELECTROBUN_DEVKIT_ROOT: join(root, 'package/dist'), HUTCH_DEFAULT_ELECTROBUN: version, HUTCH_DEFAULT_CLI: cli, HUTCH_ENGINE_BINARY: hutch };
assert.equal((await run(hutch, ['--version'], { cwd: scratch, env })).trim(), cli,
  'Source smoke must use the package-pinned Hutch, not the installed channel head');
const results = [];
const selection = process.env.SMOKE_SCENARIOS || 'all';
const allScenarios = [...templateScenarios, ...kitchenScenarios];
const selected = selection === 'all' ? allScenarios.map(s => s.id) : selection.split(',');
assert.ok(selected.length > 0 && selected.every(id => allScenarios.some(s => s.id === id)), 'Unknown source smoke scenario');
// The other UI templates are tray utilities; verify their Cottontail builds
// without granting screen-recording permissions or opening system settings.
for (const id of selection === 'all' ? ['ui-color-picker', 'ui-launcher'] : []) {
  const work = join(output, id), project = join(scratch, id);
  mkdirSync(work);
  try {
    cpSync(join(root, 'templates', id), project, { recursive: true, filter: path => !/(?:^|[/\\])(?:node_modules|build|artifacts|\.hutch|target)(?:[/\\]|$)/.test(path) });
    await run(hutch, ['run', '--if-configured', 'install'], { cwd: project, env, log: join(work, 'install.log') });
    await run(hutch, ['electrobun', 'build', '--env=dev'], { cwd: project, env, log: join(work, 'build.log'), timeout: 900_000 });
    results.push({ name: `${id} (build)`, status: 'passed' });
  } catch (error) {
    results.push({ name: `${id} (build)`, status: 'failed', error: error.message });
  }
}
for (const scenario of templateScenarios.filter(s => selected.includes(s.id))) {
  const reason = skipReason(scenario, `${process.platform === 'win32' ? 'windows' : os}-${process.arch}`);
  if (reason) { results.push({ name: scenario.id, status: 'skipped', reason }); continue; }
  const work = join(output, scenario.id), project = join(scratch, scenario.id);
  mkdirSync(work);
  try {
    cpSync(join(root, 'templates', scenario.id), project, { recursive: true, filter: path => !/(?:^|[/\\])(?:node_modules|build|artifacts|\.hutch|\.zig-cache|zig-out|target)(?:[/\\]|$)/.test(path) });
    await run(hutch, ['run', '--if-configured', 'install'], { cwd: project, env, log: join(work, 'install.log') });
    const plan = { ...scenario, name: scenario.id, output: work, cwd: project, command: [hutch, 'run', 'dev'] };
    const planPath = join(work, 'desktop-plan.json');
    writeFileSync(planPath, JSON.stringify(plan));
    // Screenshot tools may create temporary files in cwd; keep them out of
    // the application's watched sources. The app cwd is specified in plan.
    await run('python', [join(root, 'scripts/desktop-smoke/desktop.py'), planPath], { cwd: scratch, env, log: join(work, 'desktop-driver.log'), timeout: 900_000 });
    const result = JSON.parse(readFileSync(join(work, 'result.json'), 'utf8'));
    assert.equal(result.ok, true);
    results.push({ name: scenario.id, status: 'passed' });
  } catch (error) {
    results.push({ name: scenario.id, status: 'failed', error: error.message });
    console.error(`[source-smoke] ${scenario.id}: ${error.message}`);
  }
}
// Exercise the same interactive Kitchen scenarios against this source devkit.
// A short workspace keeps Windows resource-update paths below MAX_PATH.
const kitchen = join(scratch, 'kitchen');
let kitchenBuildError;
const selectedKitchen = kitchenScenarios.filter(s => selected.includes(s.id));
if (selectedKitchen.length) {
try {
  cpSync(join(root, 'kitchen'), kitchen, { recursive: true, filter: path => !/(?:^|[/\\])(?:node_modules|build|artifacts|\.hutch|target|test-results)(?:[/\\]|$)/.test(path) });
  mkdirSync(join(scratch, 'package/scripts'), { recursive: true });
  cpSync(join(root, 'package/scripts/hutch-launcher.mjs'), join(scratch, 'package/scripts/hutch-launcher.mjs'));
  await run(hutch, ['run', 'install'], { cwd: kitchen, env, log: join(output, 'kitchen-install.log') });
  await run(hutch, ['scripts/kitchen-matrix.ts', '--with=cottontail:cef', '--build-only'],
    { cwd: kitchen, env, log: join(output, 'kitchen-build.log'), timeout: 1_200_000 });
} catch (error) { kitchenBuildError = error.message; }
}
for (const scenario of selectedKitchen) {
  const work = join(output, scenario.id);
  mkdirSync(work);
  try {
    if (kitchenBuildError) throw new Error(kitchenBuildError);
    const plan = { ...scenario, name: scenario.id, output: work, cwd: kitchen,
      ...(process.platform === 'win32' && scenario.id === 'kitchen-native-ui' ? { nativeOnlyDiagnostics: true } : {}),
      command: [hutch, 'scripts/kitchen-matrix.ts', '--with=cottontail:cef', '--launch-only', '--timeout=300'],
      env: { AUTO_RUN_TEST_NAME: scenario.test } };
    const planPath = join(work, 'desktop-plan.json');
    writeFileSync(planPath, JSON.stringify(plan));
    // Screenshot tools may create temporary files in cwd; keep them out of
    // the application's watched sources. The app cwd is specified in plan.
    await run('python', [join(root, 'scripts/desktop-smoke/desktop.py'), planPath], { cwd: scratch, env, log: join(work, 'desktop-driver.log'), timeout: 330_000 });
    const result = JSON.parse(readFileSync(join(work, 'result.json'), 'utf8'));
    assert.equal(result.ok, true);
    results.push({ name: scenario.id, status: 'passed' });
  } catch (error) {
    results.push({ name: scenario.id, status: 'failed', error: error.message });
    console.error(`[source-smoke] ${scenario.id}: ${error.message}`);
  }
}
writeFileSync(join(output, 'summary.json'), JSON.stringify({ source: process.env.GITHUB_SHA, version, results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '# Source desktop smoke tests\n\n' + results.map(r => `- ${r.name}: ${r.status}`).join('\n') + '\n');
assert.ok(results.every(r => r.status === 'passed' || r.status === 'skipped'), 'Source desktop smoke tests failed; see screenshots and logs');
