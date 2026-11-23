import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contract.cjs';
test('desktop bridge accepts only fixed operations and never arbitrary commands, targets or paths', () => {
  for (const method of ['state','connect','disconnect']) assert.doesNotThrow(() => contract.validate(method, {}));
  assert.doesNotThrow(() => contract.validate('run', { action: 'build' }));
  for (const [m,p] of [['exec',{command:'id'}],['run',{action:'build',command:'id'}],['run',{action:'shell'}],['permission',{mode:'root'}],['task',{id:'../../etc/passwd'}],['connect',{url:'http://localhost:3210'}],['review',{id:'a'.repeat(36),digest:'b'.repeat(64),note:''}]]) assert.throws(() => contract.validate(m,p));
});
test('IPC sender must be the sole trusted main frame at the exact local URL', () => {
  const frame = { url: 'anywhere-desktop://app/index.html' }, contents = { mainFrame: frame };
  assert.equal(contract.trustedSender({ sender: contents, senderFrame: frame }, contents), true);
  assert.equal(contract.trustedSender({ sender: contents, senderFrame: { ...frame } }, contents), false);
  assert.equal(contract.trustedSender({ sender: {}, senderFrame: frame }, contents), false);
  for (const url of ['https://example.com/','file:///index.html','anywhere-desktop://other/index.html','anywhere-desktop://app/index.html?x']) {
    frame.url = url; assert.equal(contract.trustedSender({ sender: contents, senderFrame: frame }, contents), false);
  }
});
