import { TERMINAL, callKey, turnKey } from './protocol.mjs';

export const RETAIN_RECENT = 32;
// Both peers retain immutable requests/results; only already consumed output is
// evicted. Unknown, running and undelivered results are never compacted.
export function compactOperations(journal, side, retain = RETAIN_RECENT) {
  const archived = [];
  journal.tx(() => {
    const settled = journal.entries('ops').filter(({ value: o }) => TERMINAL.has(o.state) &&
      (side === 'agent' ? o.resultConsumed : o.delivery === 'consumed' && o.consumeConfirmed));
    for (const { key, value: op } of settled.slice(0, Math.max(0, settled.length - retain))) {
      journal.archive('ops', key); journal.archive('calls', callKey(op.request)); journal.dropOutput(key);
      archived.push(key);
      for (const r of journal.entries('cancels')) if (r.value.operationId === key) journal.archive('cancels', r.key);
      for (const r of journal.entries('reviews')) if (r.value.operationId === key) journal.archive('reviews', r.key);
    }
    const activeTurns = new Set(journal.all('ops').map(o => turnKey(o.request.scope)));
    for (const { key, value } of journal.entries('turns')) if (!activeTurns.has(key) &&
      (side === 'agent' || !value.stopped || value.stopConfirmed)) journal.archive('turns', key);
  });
  return archived;
}
