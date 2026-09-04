export interface MemoryState {
  version: 1;
  memoryRevision: number;
  qmdUpdatedRevision: number;
  qmdEmbeddedRevision: number;
}

export interface MemoryCheckpointRange {
  id: string;
  sessionId: string;
  sessionFile: string;
  fromOffset: number;
  toOffset: number;
  capturedAt?: number;
  sourceDevice?: number;
  sourceInode?: number;
}

export interface MemoryCheckpoint {
  version: 1;
  chatId: number;
  cursor?: {
    sessionId: string;
    sessionFile: string;
    offset: number;
    sourceDevice?: number;
    sourceInode?: number;
  };
  pendingHead?: string;
  pending?: MemoryCheckpointRange[];
}

export interface MemoryCheckpointNode {
  version: 1;
  id: string;
  previousId?: string;
  range: MemoryCheckpointRange;
}

export interface MemoryExtractionJob extends MemoryCheckpointRange {
  version: 1;
  chatId: number;
  status: "pending" | "running" | "failed";
  attempts: number;
  nextAttemptAt: number;
}

export interface MemoryRecoveryRecord {
  version: 1;
  id: string;
  createdAt: string;
  target: "long_term" | "daily";
  date?: string;
  removedContent: string[];
  restoredAt?: string;
}

export interface ExtractedMemoryEntry {
  target: "long_term" | "daily";
  content: string;
  date?: string;
}

export interface MemorySnapshot {
  revision: number;
  content: string;
}

export interface MemoryOperationResult {
  content: string;
  isError?: true;
}
