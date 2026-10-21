import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const rendererPath = 'src/mainview/index.ts';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function directory(value, label) {
  assert.ok(typeof value === 'string' && isAbsolute(value), `${label} must be an absolute directory path`);
  const resolved = realpathSync(value);
  assert.ok(lstatSync(resolved).isDirectory(), `${label} must be an existing directory`);
  return resolved;
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function regularFile(root, path) {
  let current = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    assert.ok(!stat.isSymbolicLink(), `Overlay path must not traverse a symlink: ${current}`);
    assert.ok(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(),
      `Overlay path must contain directories and a regular file: ${current}`);
  }
  return current;
}

// This diagnostic changes only the generated renderer source. Native artifacts,
// product/toolchain pins, and configuration remain those of the public release.
export function applyBunnySourceOverlay({ project, output, sourceRoot, revision }) {
  assert.match(typeof revision === 'string' ? revision : '', /^[a-f\d]{40}$/i,
    'Bunny source overlay requires the full 40-hex checkout revision');
  const projectRoot = directory(project, 'project');
  const outputRoot = directory(output, 'output');
  const checkoutRoot = directory(sourceRoot, 'sourceRoot');
  const roots = [projectRoot, outputRoot, checkoutRoot];
  for (let first = 0; first < roots.length; first++) {
    for (let second = first + 1; second < roots.length; second++) {
      assert.ok(!contains(roots[first], roots[second]) && !contains(roots[second], roots[first]),
        'Project, artifact output, and source checkout must be separate directories');
    }
  }
  const target = regularFile(projectRoot, rendererPath);
  const source = regularFile(checkoutRoot, `templates/bunny/${rendererPath}`);
  const originalFile = join(outputRoot, 'bunny-source-overlay-original.ts');
  const manifestFile = join(outputRoot, 'bunny-source-overlay.json');
  for (const artifact of [originalFile, manifestFile]) {
    assert.equal(lstatSync(artifact, { throwIfNoEntry: false }), undefined,
      `Overlay evidence already exists: ${artifact}`);
  }
  // Complete validation and read both files before creating any artifacts.
  const original = readFileSync(target);
  const overlay = readFileSync(source);
  const metadata = {
    schema: 1,
    revision,
    path: rendererPath,
    source,
    project: projectRoot,
    originalFile,
    originalSha256: sha256(original),
    overlaySha256: sha256(overlay),
  };
  const temporary = join(dirname(target), `.bunny-source-overlay-${randomUUID()}.ts`);
  const created = [];
  const writeNew = (file, bytes, mode = 0o666) => {
    const descriptor = openSync(file, 'wx', mode);
    created.push(file);
    try { writeFileSync(descriptor, bytes); } finally { closeSync(descriptor); }
  };
  try {
    writeNew(originalFile, original);
    writeNew(manifestFile, JSON.stringify(metadata, null, 2) + '\n');
    writeNew(temporary, overlay, lstatSync(target).mode & 0o777);
    // An unsuccessful write/rename leaves the generated source intact.
    renameSync(temporary, target);
  } catch (error) {
    for (const file of created.reverse()) rmSync(file, { force: true });
    throw error;
  }
  return metadata;
}
