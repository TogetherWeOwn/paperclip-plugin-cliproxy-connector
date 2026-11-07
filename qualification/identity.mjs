import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

export const CANDIDATE = 'c129014d765b400d8e547ff469499cd3c34429ff';
export const HOST_SOURCE = 'd69631b01b9c658f80bf8bed389863dce82643e1';
export const HOST_IMAGE = 'sha256:281d80a20c0b333c519f158c77cd18a5096d086f648ed490d218ac7c8bc48e39';

export function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = join(root, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected artifact symlink: ${entry.name}`);
    return entry.isDirectory() ? filesUnder(file) : [file];
  }).sort();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const candidate = resolve(process.argv[2]);
  const evidence = resolve(process.argv[3]);
  const [image] = JSON.parse(readFileSync(join(evidence, 'image.json'), 'utf8'));
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], HOST_SOURCE);
  assert.equal(image.Architecture, 'amd64');
  assert(image.RepoDigests.includes(`ghcr.io/paperclipai/paperclip@${HOST_IMAGE}`));
  assert.equal(execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), CANDIDATE);
  const lock = JSON.parse(readFileSync(join(candidate, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@paperclipai/plugin-sdk'].version, '2026.1023.0');
  const artifacts = Object.fromEntries(filesUnder(join(candidate, 'dist')).map(file => [relative(candidate, file), digest(file)]));
  assert(artifacts['dist/worker.js']);
  assert(artifacts['dist/ui/index.js']);
  writeFileSync(join(evidence, 'identity.json'), JSON.stringify({
    schema: 1,
    qualificationStatus: 'partial-preflight-only',
    candidateSha: CANDIDATE,
    candidateTree: execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    workflowCheckoutSha: execFileSync('git', ['-C', resolve('workflow'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workflowEventSha: process.env.GITHUB_SHA,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    job: process.env.GITHUB_JOB,
    runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
    expectedHostRelease: '2026.1106.0',
    hostSourceSha: HOST_SOURCE,
    hostImageManifest: HOST_IMAGE,
    hostImageId: image.Id,
    hostImageLabels: image.Config.Labels,
    sdkVersion: '2026.1023.0',
    candidateLockSha256: digest(join(candidate, 'package-lock.json')),
    candidatePackageSha256: digest(join(candidate, 'package.json')),
    artifacts,
    artifactRetentionDays: 7,
    missing: ['installed scenario matrix', 'native router eligibility', 'browser assertions and traces', 'exact-candidate Security and final QA acceptance'],
  }, null, 2));
}
