import { TERMINAL, resultDigest, fail } from './protocol.mjs';

// Trusted deterministic harness; this is NOT an implementation of either CLI's
// history/resume protocol. It models a consumer that can persist receipt atomically.
export class MockRunner {
  constructor(journal) { this.journal = journal; }
  async consume(operation, acknowledge) {
    if (!TERMINAL.has(operation.state) || operation.receivedSeq !== operation.lastSeq ||
        operation.resultDigest !== resultDigest(operation)) fail('RESULT_NOT_READY');
    this.journal.tx(() => {
      const prior = this.journal.get('consumed', operation.operationId);
      if (prior && prior.digest !== operation.resultDigest) fail('RESULT_CONFLICT');
      if (!prior) this.journal.put('consumed', operation.operationId, {
        operationId: operation.operationId, digest: operation.resultDigest, requestHash: operation.requestHash,
        scope: operation.request.scope, result: operation.result, state: operation.state,
        lastSeq: operation.lastSeq, gaps: operation.gaps, acceptedIntoMockHistory: true,
      });
    });
    // A crash/lost acknowledgement here only repeats the ack, not the task or
    // insertion into mock history. Displayed is intentionally not sufficient.
    return acknowledge({ operationId: operation.operationId, digest: operation.resultDigest, stage: 'consumed' });
  }
}
