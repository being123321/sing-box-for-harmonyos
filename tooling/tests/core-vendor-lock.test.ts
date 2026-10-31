import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '../..');
const verifier = join(projectRoot, 'scripts/core_vendor.py');
const lockPath = join(projectRoot, 'third_party/core-lock.json');
const ohosReplayPatch = join(
  projectRoot,
  'third_party/patches/ohos-go1.24.13-openharmony.patch'
);

function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
}

function createTaggedFixture(): {
  root: string;
  lock: Record<string, unknown>;
  lockFile: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'hna-core-stage-fixture-'));
  const repository = join(root, 'upstream');
  mkdirSync(repository);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'HNA fixture']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repository, 'README.md'), 'upstream\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '--quiet', '-m', 'fixture']);
  git(repository, ['tag', 'v1.0.0']);

  writeFileSync(join(repository, 'README.md'), 'patched\n');
  const patch = join(root, 'component.patch');
  writeFileSync(patch, execFileSync('git', ['-C', repository, 'diff', '--binary'], {
    encoding: 'utf8'
  }));
  git(repository, ['checkout', '--quiet', '--', 'README.md']);

  const lock = {
    schema_version: 2,
    delivery_policy: {
      native_core: 'signed-hap-only',
      runtime_core_download: false
    },
    sing_box: {
      version: 'v1.0.0',
      source: repository,
      tag_object: git(repository, ['rev-parse', 'refs/tags/v1.0.0']),
      commit: git(repository, ['rev-parse', 'refs/tags/v1.0.0^{commit}']),
      upstream_tree: git(repository, ['rev-parse', 'refs/tags/v1.0.0^{tree}']),
      patch_path: patch,
      patch_sha256: execFileSync('shasum', ['-a', '256', patch], { encoding: 'utf8' })
        .split(/\s+/)[0],
      vendor_tree_sha256: '0'.repeat(64)
    }
  };
  const lockFile = join(root, 'core-lock.json');
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  return { root, lock, lockFile };
}

test('checked-in native core inputs match the immutable lock', () => {
  const result = execFileSync('python3', [verifier, 'verify-local'], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  assert.match(result, /CORE LOCK VERIFIED/);
});

test('OHOS Go source can be verified before ignored host binaries are built', () => {
  const result = execFileSync('python3', [verifier, 'verify-toolchain-source'], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  assert.match(result, /OHOS GO SOURCE AND REPLAY VERIFIED/);
});

test('OHOS Go source lock verifies from a real clean Git archive', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'hna-core-clean-archive-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const archive = join(directory, 'source.tar');
  const checkout = join(directory, 'checkout');
  mkdirSync(checkout);

  execFileSync('git', ['archive', '--format=tar', '-o', archive, 'HEAD'], {
    cwd: projectRoot,
    stdio: 'pipe'
  });
  execFileSync('tar', ['-xf', archive, '-C', checkout], { stdio: 'pipe' });

  // Use the candidate lock from the worktree so this pre-commit regression
  // exercises the immutable Git archive without depending on generated files
  // left behind by a previous local toolchain build.
  copyFileSync(lockPath, join(checkout, 'third_party', 'core-lock.json'));
  copyFileSync(verifier, join(checkout, 'scripts', 'core_vendor.py'));
  copyFileSync(
    ohosReplayPatch,
    join(checkout, 'third_party', 'patches', 'ohos-go1.24.13-openharmony.patch')
  );
  copyFileSync(
    join(
      projectRoot,
      'third_party',
      'ohos-golang-go-1.24',
      'OPENHARMONY_PORT_PROVENANCE.md'
    ),
    join(
      checkout,
      'third_party',
      'ohos-golang-go-1.24',
      'OPENHARMONY_PORT_PROVENANCE.md'
    )
  );
  const result = execFileSync(
    'python3',
    [join(checkout, 'scripts', 'core_vendor.py'), 'verify-toolchain-source'],
    { cwd: checkout, encoding: 'utf8' }
  );
  assert.match(result, /OHOS GO SOURCE AND REPLAY VERIFIED/);
});

test('native core delivery remains signed-HAP-only', () => {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(lock.schema_version, 2);
  assert.equal(lock.delivery_policy.native_core, 'signed-hap-only');
  assert.equal(lock.delivery_policy.runtime_core_download, false);
  assert.equal(lock.ohos_go.version, 'go1.24.13');
  assert.match(lock.ohos_go.bootstrap_version, /^go\d+\.\d+\.\d+$/);
  assert.equal(lock.ohos_go.upstream_go_commit, '96e4e2b1616c3c59577d48abcf2823bf1fdcd2e2');
  assert.equal(lock.ohos_go.upstream_go_tree, 'cf852168cdd867dc2d5439b8b1ca476825772632');
  assert.equal(lock.sing_box.tag_object, lock.sing_box.commit);
  assert.equal(existsSync(join(projectRoot, 'third_party', 'sing-box.version')), false);
  assert.equal(existsSync(join(projectRoot, 'third_party', 'gvisor.version')), false);
});

test('OHOS Go replay patch reconstructs the pinned base and exact checked-in result offline', () => {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.match(lock.ohos_go.upstream_source_tree_sha256, /^[0-9a-f]{64}$/);
  assert.match(lock.ohos_go.replay_patch_sha256, /^[0-9a-f]{64}$/);
  assert.match(readFileSync(ohosReplayPatch, 'utf8'), /^diff --git /);
});

test('single-component stage verifies tag object, commit and tree then atomically promotes', (context) => {
  const fixture = createTaggedFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const candidate = join(fixture.root, 'candidate');
  const first = execFileSync(
    'python3',
    [
      verifier,
      '--lock',
      fixture.lockFile,
      'stage-component',
      '--allow-unpinned-result',
      'sing-box',
      candidate
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  const report = JSON.parse(first);
  assert.equal(report.component, 'sing-box');
  assert.equal(report.candidate_promotion, 'atomic-rename');
  assert.equal(report.vendor_promotion_performed, false);
  assert.equal(readFileSync(join(candidate, 'source', 'README.md'), 'utf8'), 'patched\n');

  const pinned = structuredClone(fixture.lock) as any;
  pinned.sing_box.vendor_tree_sha256 = report.source_tree_sha256;
  const pinnedLock = join(fixture.root, 'pinned-lock.json');
  writeFileSync(pinnedLock, `${JSON.stringify(pinned, null, 2)}\n`);
  const reproduced = join(fixture.root, 'reproduced');
  const second = execFileSync(
    'python3',
    [verifier, '--lock', pinnedLock, 'stage-component', 'sing-box', reproduced],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  assert.equal(JSON.parse(second).result, 'reproduced-locked-component');
});

test('single-component stage fails closed for each tag identity without partial output', (context) => {
  const fixture = createTaggedFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  for (const field of ['tag_object', 'commit', 'upstream_tree']) {
    const tampered = structuredClone(fixture.lock) as any;
    tampered.sing_box[field] = '0'.repeat(40);
    const candidateLock = join(fixture.root, `${field}.json`);
    const output = join(fixture.root, `${field}-output`);
    writeFileSync(candidateLock, `${JSON.stringify(tampered, null, 2)}\n`);
    const result = spawnSync(
      'python3',
      [
        verifier,
        '--lock',
        candidateLock,
        'stage-component',
        '--allow-unpinned-result',
        'sing-box',
        output
      ],
      { cwd: projectRoot, encoding: 'utf8' }
    );
    assert.notEqual(result.status, 0, field);
    assert.match(result.stderr, new RegExp(field === 'upstream_tree' ? 'tree' : field.replace('_', ' ')));
    assert.equal(existsSync(output), false, field);
    assert.equal(
      readdirSync(fixture.root).some((name) => name.startsWith(`.${field}-output.stage-`)),
      false,
      field
    );
  }
});

test('staging refuses any repository-internal destination before creating output', (context) => {
  const fixture = createTaggedFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const output = join(projectRoot, 'artifacts', 'forbidden-core-stage');
  const result = spawnSync(
    'python3',
    [
      verifier,
      '--lock',
      fixture.lockFile,
      'stage-component',
      '--allow-unpinned-result',
      'sing-box',
      output
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the repository/);
  assert.equal(existsSync(output), false);
});

test('verifier fails closed when a patch digest is changed', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'hna-core-lock-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const tamperedLock = JSON.parse(readFileSync(lockPath, 'utf8'));
  tamperedLock.sing_box.patch_sha256 = '0'.repeat(64);
  const candidate = join(directory, 'core-lock.json');
  writeFileSync(candidate, `${JSON.stringify(tamperedLock, null, 2)}\n`);

  const result = spawnSync('python3', [verifier, '--lock', candidate, 'verify-local'], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sing-box patch drift/);
});

test('common verify-local gate executes the complete OHOS Go replay proof', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'hna-ohos-replay-lock-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const tamperedLock = JSON.parse(readFileSync(lockPath, 'utf8'));
  tamperedLock.ohos_go.upstream_source_tree_sha256 = '0'.repeat(64);
  const candidate = join(directory, 'core-lock.json');
  writeFileSync(candidate, `${JSON.stringify(tamperedLock, null, 2)}\n`);

  const result = spawnSync('python3', [verifier, '--lock', candidate, 'verify-local'], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OHOS Go replay base drift/);
});

test('native core tests and production build share one complete tag set', () => {
  const expectedTags =
    'with_gvisor,with_quic,with_utls,with_clash_api,with_tailscale,badlinkname,tfogo_checklinkname0';
  const environment = readFileSync(join(projectRoot, 'scripts/core_build_env.sh'), 'utf8');
  const buildScript = readFileSync(join(projectRoot, 'scripts/build_core.sh'), 'utf8');
  const smokeScript = readFileSync(join(projectRoot, 'scripts/core_smoke_test.sh'), 'utf8');

  assert.match(environment, new RegExp(`HNA_CORE_BUILD_TAGS='${expectedTags}'`));
  assert.match(buildScript, /source "\$project_root\/scripts\/core_build_env\.sh"/);
  assert.equal(buildScript.match(/-tags "\$HNA_CORE_BUILD_TAGS"/g)?.length, 2);
  assert.equal(buildScript.match(/-mod=readonly/g)?.length, 2);
  assert.doesNotMatch(buildScript, /-mod=mod/);
  assert.match(smokeScript, /source "\$project_root\/scripts\/core_build_env\.sh"/);
  assert.equal(smokeScript.match(/-tags "\$HNA_CORE_BUILD_TAGS"/g)?.length, 4);
  assert.equal(smokeScript.match(/GOFLAGS=-mod=readonly/g)?.length, 4);
  assert.doesNotMatch(buildScript, /with_gvisor,with_quic/);
  assert.doesNotMatch(smokeScript, /with_gvisor,with_quic/);
});
