/** Trusted host binding; never part of a model-facing tool schema. */
export interface WorkspaceBinding {
  accountId: string; deviceId: string; workspaceId: string;
  sessionId: string; turnId: string; turnEpoch: number; grantVersion: number;
}
export type PermissionMode = 'revoked' | 'read' | 'edit' | 'execute';
export type TaskState = 'prepared' | 'dispatching' | 'not_received' | 'accepted' | 'running' |
  'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'rejected' | 'unknown';
export interface LocalPermissionChange {
  requestId: string; expectedVersion: number; mode: PermissionMode;
}
export interface TaskHandle {
  operationId: string; taskId: string | null; state: TaskState;
  cancelRequested: boolean; cancelConfirmed: boolean;
  resultReady: boolean; resultDigest: string | null;
  delivery: 'pending' | 'presented' | 'consumed';
  lastSeq: number; receivedSeq: number; outputNextSeq: number; moreOutput: boolean;
  gaps: Array<{ from: number; through: number }>;
  reason: string | null;
}
export interface CallTicket { ticket: string; operationId: string; requestHash: string }
/** API boundary for CLI host integration in phase F. */
export interface WorkspaceExecutorContract {
  issue(hostCallId: string, toolName: string, args: Record<string, unknown>, options?: { expiresAt?: number }): Promise<CallTicket>;
  invoke(toolName: string, args: Record<string, unknown>, ticket: string, options?: { waitMs?: number; signal?: AbortSignal }): Promise<unknown>;
  status(operationId: string): Promise<unknown>;
  cancel(operationId: string): Promise<unknown>;
  output(operationId: string, afterSeq?: number): Promise<unknown>;
  /** Only after the host commits the terminal result to its own history. */
  consumeAfterPersist(receipt: { operationId: string; resultDigest: string; receiptId: string }): Promise<{ consumed: true }>;
}
