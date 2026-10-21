import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { applyBunnySourceOverlay } from './bunny-source-overlay.mjs';

const revision = '0123456789abcdef0123456789abcdef01234567';
const rendererPath = 'src/mainview/index.ts';
const original = Buffer.from('\ufeff// Published Bunny\r\nconst name = "Bunny 🐇";\r\n');
const overlay = Buffer.from('// Reviewed renderer fix\nconst ready = true;\n');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function write(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bunny-source-overlay-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { project: join(root, 'project'), output: join(root, 'artifacts'), sourceRoot: join(root, 'checkout'), revision };
  mkdirSync(options.output);
  write(join(options.project, rendererPath), original);
  write(join(options.sourceRoot, 'templates/bunny', rendererPath), overlay);
  for (const path of ['package.json', 'hutch.config.ts', 'hutch.lock', 'electrobun.config.ts',
    '.hutch/devkit/projection.json', 'build/native-wrapper.dylib', 'src/bun/index.ts', 'src/mainview/other.ts']) {
    write(join(options.project, path), `published:${path}\n`);
    write(join(options.sourceRoot, 'templates/bunny', path), `must-not-copy:${path}\n`);
  }
  return { root, options };
}

function snapshot(root) {
  const files = {};
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), path = prefix + name, stat = lstatSync(file);
      if (stat.isSymbolicLink()) files[path] = { symlink: readlinkSync(file) };
      else if (stat.isDirectory()) { files[path + '/'] = 'directory'; visit(file, path + '/'); }
      else files[path] = readFileSync(file).toString('hex');
    }
  };
  visit(root);
  return files;
}

function assertNoWrites(root, options, expected) {
  const before = snapshot(root);
  assert.throws(() => applyBunnySourceOverlay(options), expected);
  assert.deepEqual(snapshot(root), before, 'a rejected overlay must leave every file and directory untouched');
}

test('Bunny overlay changes only the allowlisted renderer and preserves exact source provenance', t => {
  const { options } = fixture(t);
  const before = snapshot(options.project), checkout = snapshot(options.sourceRoot);
  const metadata = applyBunnySourceOverlay(options);
  const after = snapshot(options.project);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const path of Object.keys(before)) assert.equal(after[path], path === rendererPath ? overlay.toString('hex') : before[path], path);
  assert.deepEqual(snapshot(options.sourceRoot), checkout, 'the reviewed checkout stays unchanged');
  assert.deepEqual(readFileSync(metadata.originalFile), original, 'retain original BOM, CRLF, and UTF-8 bytes');
  assert.deepEqual(metadata, {
    schema: 1, revision, path: rendererPath,
    source: join(options.sourceRoot, 'templates/bunny', rendererPath), project: options.project,
    originalFile: join(options.output, 'bunny-source-overlay-original.ts'),
    originalSha256: digest(original), overlaySha256: digest(overlay),
  });
  assert.deepEqual(JSON.parse(readFileSync(join(options.output, 'bunny-source-overlay.json'), 'utf8')), metadata);
  assert.deepEqual(readdirSync(options.output).sort(), ['bunny-source-overlay-original.ts', 'bunny-source-overlay.json']);
  assertNoWrites(options.output, options, /evidence already exists/);
  assert.deepEqual(readFileSync(join(options.project, rendererPath)), overlay);
});

test('Bunny overlay rejects invalid revisions and roots before writing', t => {
  const { root, options } = fixture(t);
  for (const invalid of [undefined, '', 'main', revision.slice(1), 'g'.repeat(40)]) {
    assertNoWrites(root, { ...options, revision: invalid }, /40-hex checkout revision/);
  }
  for (const key of ['project', 'output', 'sourceRoot']) {
    assertNoWrites(root, { ...options, [key]: 'relative/path' }, /absolute directory path/);
    assertNoWrites(root, { ...options, [key]: join(root, 'absent') }, /ENOENT/);
  }
  assertNoWrites(root, { ...options, output: options.project }, /separate directories/);
  assertNoWrites(root, { ...options, output: join(options.project, 'src') }, /separate directories/);
  assertNoWrites(root, { ...options, output: options.sourceRoot }, /separate directories/);
});

test('Bunny overlay rejects missing source or target and artifact collisions without partial evidence', async t => {
  for (const missing of ['source', 'target']) {
    await t.test(missing, t => {
      const { root, options } = fixture(t);
      rmSync(missing === 'source' ? join(options.sourceRoot, 'templates/bunny', rendererPath) : join(options.project, rendererPath));
      assertNoWrites(root, options, /ENOENT/);
    });
  }
  for (const artifact of ['bunny-source-overlay-original.ts', 'bunny-source-overlay.json']) {
    await t.test(artifact, t => {
      const { root, options } = fixture(t);
      write(join(options.output, artifact), 'existing evidence');
      assertNoWrites(root, options, /evidence already exists/);
    });
  }
});

test('Bunny overlay rejects symlinked source or generated renderer paths before writing', async t => {
  for (const location of ['source', 'target']) {
    await t.test(location, t => {
      const { root, options } = fixture(t);
      const directory = location === 'source' ? join(options.sourceRoot, 'templates/bunny/src/mainview') : join(options.project, 'src/mainview');
      const external = join(root, 'external');
      write(join(external, 'index.ts'), 'outside the allowlist');
      rmSync(directory, { recursive: true });
      symlinkSync(external, directory, process.platform === 'win32' ? 'junction' : 'dir');
      assertNoWrites(root, options, /must not traverse a symlink/);
    });
  }
});
