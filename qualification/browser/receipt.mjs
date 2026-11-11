import assert from 'node:assert/strict';

export function providerBindingText(provider) {
  assert(Array.isArray(provider.connectionIds) && provider.connectionIds.length > 0, 'Missing installed connection IDs');
  assert(provider.connectionIds.every(id => typeof id === 'string' && id.length > 0));
  return `connection${provider.connectionIds.length === 1 ? '' : 's'} ${provider.connectionIds.join(', ')} · completeInventory`;
}

export function assertBrowserComplete(receipt) {
  assert.equal(receipt.attempts.length, 28, 'Incomplete browser coverage');
  assert.deepEqual(receipt.failures, [], 'Candidate browser agreement failures retained; not qualified');
  assert(receipt.attempts.every(attempt => attempt.agreement && attempt.exactCandidateUiLoaded), 'Browser attempt did not agree with exact candidate');
  assert.equal(receipt.observations.length, 28);
}
