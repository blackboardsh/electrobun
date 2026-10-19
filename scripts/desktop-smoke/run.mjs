#!/usr/bin/env node
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acceptanceEnvironment, run, validateCatalog } from '../accept-published-template.mjs';
import { npmInvocation, validateRunnerPlatform } from '../../npm/scripts/accept-published-bootstrap.mjs';
import { parseHutchPragma, releaseChannel } from '../publish-templates.mjs';
import { templateScenarios, kitchenScenarios, skipReason } from './scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const publicBase = 'https://electrobun-artifacts.blackboard.sh/electrobun/templates';

export async function prepareRelease({ version, platform, output }) {
  validateRunnerPlatform(platform);
  const channel = releaseChannel(version);
  const work = resolve(output);
  mkdirSync(work, { recursive: true });
  // Keep Win32 resource-update paths below MAX_PATH. Kitchen's variant
  // workspace adds several directories after this root. Artifacts stay in work.
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'ebs-'));
  writeFileSync(join(scratch, 'empty.npmrc'), '');
  const env = acceptanceEnvironment(process.env, scratch);
  // Keep tooling paths, but no developer devkit/runtime/catalog overrides.
  if (process.env.SMOKE_TESSERACT) env.SMOKE_TESSERACT = process.env.SMOKE_TESSERACT;
  const response = await fetch(`${publicBase}/channels/${channel}.json`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Catalog HTTP ${response.status}`);
  const catalog = await response.json();
  validateCatalog(catalog, version, catalog.tools);
  writeFileSync(join(work, 'catalog.json'), JSON.stringify(catalog, null, 2));
  const bootstrap = join(scratch, 'bootstrap');
  mkdirSync(bootstrap);
  writeFileSync(join(bootstrap, 'package.json'), JSON.stringify({ private: true }));
  const npm = npmInvocation(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `electrobun@${version}`]);
  await run(npm.command, npm.args, { cwd: bootstrap, env, log: join(work, 'npm-install.log') });
  const resolver = createRequire(import.meta.url)(join(bootstrap, 'node_modules/electrobun/bin/resolve-hutch.cjs'));
  assert.equal(resolver.ELECTROBUN_VERSION, version);
  assert.equal(resolver.PAIRED_HUTCH_VERSION, catalog.tools.hutch, 'npm and template catalog disagree on Hutch');
  const hutch = await resolver.resolveHutchBinary({ environment: env });
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${dirname(hutch)}${delimiter}${env[pathKey] ?? ''}`;
  assert.equal((await run(hutch, ['--version'], { env, cwd: scratch })).trim(), catalog.tools.hutch);
  return { work, scratch, env, hutch, catalog, channel };
}

export async function smokeRelease(options) {
  const results = [];
  const work = resolve(options.output);
  mkdirSync(work, { recursive: true });
  let preparationError;
  let selected = [];
  try {
    const { scratch, env, hutch, catalog, channel } = await prepareRelease(options);
    const python = process.env.SMOKE_PYTHON || 'python';
    const allScenarios = [...templateScenarios, ...kitchenScenarios];
    const selection = options.scenarios || options.templates || 'all';
    selected = selection === 'all' ? allScenarios.map(s => s.id) : selection.split(',');
    assert.ok(selected.every(id => allScenarios.some(s => s.id === id)), 'Unknown smoke scenario');
    for (const scenario of templateScenarios.filter(s => selected.includes(s.id))) {
      const output = join(work, scenario.id);
      mkdirSync(output);
      const reason = skipReason(scenario, options.platform);
      if (reason) { results.push({ name: scenario.id, status: 'skipped', reason }); continue; }
      console.log(`[desktop-smoke] ${scenario.id}: interactive init → hutch dev → desktop interaction`);
      try {
        const index = catalog.templates.findIndex(t => t.id === scenario.id);
        assert.ok(index >= 0, `Published template missing: ${scenario.id}`);
        const projectName = `smoke-${scenario.id}`;
        const project = join(scratch, projectName);
        const picker = { hutch, channel, cwd: scratch, index, id: scenario.id, label: catalog.templates[index].name,
          projectName, version: options.version, log: join(output, 'picker.log') };
        const pickerPath = join(output, 'picker-plan.json');
        writeFileSync(pickerPath, JSON.stringify(picker));
        await run(python, [join(here, 'picker.py'), pickerPath], { env, cwd: scratch, log: join(output, 'init-driver.log'), timeout: 920_000 });
        const config = readFileSync(join(project, 'hutch.config.ts'), 'utf8');
        assert.deepEqual(parseHutchPragma(config), catalog.tools);
        assert.ok(config.includes(`version: "${options.version}"`), 'Project product pin differs from release');
        const projection = JSON.parse(readFileSync(join(project, '.hutch/devkit/projection.json'), 'utf8'));
        assert.equal(projection.product.version, options.version);
        const plan = { ...scenario, name: scenario.id, output, cwd: project, command: [hutch, 'dev'] };
        const planPath = join(output, 'desktop-plan.json');
        writeFileSync(planPath, JSON.stringify(plan));
        await run(python, [join(here, 'desktop.py'), planPath], { env, cwd: scratch, log: join(output, 'desktop-driver.log'), timeout: 900_000 });
        const result = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'));
        assert.equal(result.ok, true);
        results.push({ ...result, status: 'passed' });
      } catch (error) {
        const reportPath = join(output, 'result.json');
        const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
        results.push({ ...report, name: scenario.id, status: 'failed', error: error.message });
        console.error(`[desktop-smoke] ${scenario.id}: ${error.message}`);
      }
    }
    // Build the exact tagged Kitchen sources against the published devkit. Do
    // not use this checkout's unpublished package/dist or a local runtime.
    const selectedKitchen = kitchenScenarios.filter(s => selected.includes(s.id));
    if (selectedKitchen.length) {
      const source = join(scratch, 'release-source');
      mkdirSync(source);
      const git = async args => run('git', args, { cwd: source, env, log: join(work, `git-${args[0]}.log`) });
      await git(['init']);
      await git(['remote', 'add', 'origin', 'https://github.com/blackboardsh/electrobun.git']);
      await git(['sparse-checkout', 'set', 'kitchen', 'package/scripts']);
      await git(['fetch', '--depth=1', '--filter=blob:none', 'origin', `refs/tags/v${options.version}`]);
      await git(['checkout', '--detach', 'FETCH_HEAD']);
      const kitchen = join(source, 'kitchen');
      const kitchenConfig = readFileSync(join(kitchen, 'hutch.config.ts'), 'utf8');
      assert.deepEqual(parseHutchPragma(kitchenConfig), catalog.tools);
      assert.ok(kitchenConfig.includes(`version: "${options.version}"`), 'Tagged Kitchen product pin differs from release');
      await run(hutch, ['run', 'install'], { cwd: kitchen, env, log: join(work, 'kitchen-install.log') });
      await run(hutch, ['scripts/kitchen-matrix.ts', '--with=cottontail:cef', '--build-only'],
        { cwd: kitchen, env, log: join(work, 'kitchen-build.log'), timeout: 1_200_000 });
      for (const scenario of selectedKitchen) {
        const output = join(work, scenario.id);
        mkdirSync(output);
        console.log(`[desktop-smoke] ${scenario.id}`);
        try {
          const plan = { ...scenario, name: scenario.id, output, cwd: kitchen,
            command: [hutch, 'scripts/kitchen-matrix.ts', '--with=cottontail:cef', '--launch-only', '--timeout=300'],
            env: { AUTO_RUN_TEST_NAME: scenario.test } };
          const planPath = join(output, 'desktop-plan.json');
          writeFileSync(planPath, JSON.stringify(plan));
          await run(python, [join(here, 'desktop.py'), planPath], { cwd: scratch, env, log: join(output, 'desktop-driver.log'), timeout: 330_000 });
          const result = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'));
          assert.equal(result.ok, true);
          results.push({ ...result, status: 'passed' });
        } catch (error) {
          const reportPath = join(output, 'result.json');
          const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
          results.push({ ...report, name: scenario.id, status: 'failed', error: error.message });
          console.error(`[desktop-smoke] ${scenario.id}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    preparationError = error.message;
    throw error;
  } finally {
    for (const id of selected) {
      if (!results.some(result => result.name === id)) {
        results.push({ name: id, status: 'not-run', reason: preparationError || 'Scenario did not finish' });
      }
    }
    const report = { version: options.version, platform: options.platform, results, preparationError };
    writeFileSync(join(work, 'summary.json'), JSON.stringify(report, null, 2));
    const lines = [`# Published release desktop smoke test`, '', `Release: ${options.version}; runner: ${options.platform}`, '',
      ...(preparationError ? [`Preparation failed: ${preparationError}`, ''] : []),
      '| Scenario | Result |', '| --- | --- |', ...results.map(r => `| ${r.name} | ${r.status}${r.reason ? `: ${r.reason}` : ''} |`), '',
      'Desktop screenshots and per-template logs are in this job’s smoke artifact.'];
    writeFileSync(join(work, 'index.md'), lines.join('\n'));
    const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    writeFileSync(join(work, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Release smoke screenshots</title><style>body{font:16px system-ui;margin:2rem;background:#17191e;color:#eee}img{max-width:100%;border:1px solid #777}section{margin:3rem 0}a{color:#8cc8ff}</style><h1>Electrobun ${escape(options.version)} — ${escape(options.platform)}</h1>${preparationError ? `<p>Preparation failed: ${escape(preparationError)}</p>` : ''}` + results.map(r => `<section><h2>${escape(r.name)}: ${escape(r.status)}</h2><p>${escape(r.error || r.reason || '')}</p>` + (r.screenshots || []).map(file => `<figure><a href="${escape(r.name)}/${escape(file)}"><img src="${escape(r.name)}/${escape(file)}"></a><figcaption>${escape(file)}</figcaption></figure>`).join('') + '</section>').join(''));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  assert.ok(results.length > 0 && results.every(r => r.status === 'passed' || r.status === 'skipped'), 'Desktop smoke tests failed; see summary.json and screenshots');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--version', '--platform', '--output', '--templates', '--scenarios'].includes(args[i]) && args[i + 1], 'Expected --version VERSION --platform PLATFORM --output DIRECTORY [--scenarios all|IDS]');
    options[args[i].slice(2)] = args[i + 1];
  }
  await smokeRelease(options);
}
