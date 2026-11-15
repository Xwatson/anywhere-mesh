import { exact, string, integer, fail, hash, canonical } from './protocol.mjs';

const capabilities = {
  revoked: [], read: ['dc.tool', 'dc.search'],
  edit: ['dc.tool', 'dc.search', 'workspace.write'],
  execute: ['dc.tool', 'dc.search', 'workspace.write', 'dc.run', 'workspace.exec'],
};
export const modes = Object.keys(capabilities);
export function identityOf(grant) {
  return Object.fromEntries(['accountId', 'deviceId', 'workspaceId'].map((key) => [key, string(grant[key])]));
}
export function assertIdentity(grant, expected) {
  for (const [key, value] of Object.entries(identityOf(expected))) if (grant?.[key] !== value) fail('SCOPE_DENIED');
}
export function grantFor(identity, mode, version) {
  if (!Object.hasOwn(capabilities, mode)) fail('INVALID_PERMISSION_MODE');
  integer(version, 1, 1e9);
  return { ...identityOf(identity), grantVersion: version, mode, revoked: mode === 'revoked', capabilities: [...capabilities[mode]] };
}
export function validateGrant(grant, identity) {
  exact(grant, ['accountId', 'deviceId', 'workspaceId', 'grantVersion', 'mode', 'revoked', 'capabilities']);
  assertIdentity(grant, identity);
  if (canonical(grant) !== canonical(grantFor(identity, grant.mode, grant.grantVersion))) fail('INVALID_GRANT');
  return grant;
}
// Authority lives only on the domestic device. Remote MCP has no grant endpoint.
export class GrantAuthority {
  constructor(journal, identity) {
    this.journal = journal; this.identity = identityOf(identity);
    if (!journal.get('meta', 'workspaceGrant')) journal.tx(() => {
      const initial = grantFor(identity, 'revoked', 1);
      journal.put('grants', '1', initial); journal.put('meta', 'workspaceGrant', initial);
    });
    validateGrant(this.current, identity);
  }
  get current() { return this.journal.get('meta', 'workspaceGrant'); }
  historical(version) {
    integer(version, 1, 1e9);
    return this.journal.get('grants', String(version)) ?? fail('GRANT_UNKNOWN');
  }
  change(params) {
    exact(params, ['requestId', 'expectedVersion', 'mode']); string(params.requestId);
    integer(params.expectedVersion, 1, 1e9);
    if (!modes.includes(params.mode)) fail('INVALID_PERMISSION_MODE');
    return this.journal.tx(() => {
      const prior = this.journal.get('grantChanges', params.requestId);
      if (prior) { if (prior.digest !== hash(params)) fail('GRANT_CHANGE_CONFLICT'); return prior.grant; }
      if (params.expectedVersion !== this.current.grantVersion) fail('GRANT_VERSION_CONFLICT');
      // Capacity may disable new grants, but must never trap a device in an
      // authorized mode. Reserve one final record for revocation at the limit.
      if (this.journal.all('grants').length >= 64 &&
          !(params.mode === 'revoked' && this.current.mode !== 'revoked')) fail('GRANT_HISTORY_CAPACITY');
      const next = grantFor(this.identity, params.mode, this.current.grantVersion + 1);
      this.journal.put('grants', String(next.grantVersion), next);
      this.journal.put('meta', 'workspaceGrant', next);
      this.journal.put('grantChanges', params.requestId, { digest: hash(params), grant: next });
      return next;
    });
  }
}
