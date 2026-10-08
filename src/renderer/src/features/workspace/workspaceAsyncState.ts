/** Identifies the newest request in a UI scope so late results can be ignored. */
export class AsyncRequestEpoch {
  private value = 0;

  next(): number {
    this.value += 1;
    return this.value;
  }

  invalidate(): void {
    this.value += 1;
  }

  isCurrent(request: number): boolean {
    return request === this.value;
  }
}

/** Revisions change synchronously with user edits, before React renders again. */
export class DraftRevision {
  private value = 0;

  capture(): number {
    return this.value;
  }

  advance(): number {
    this.value += 1;
    return this.value;
  }

  isCurrent(revision: number): boolean {
    return revision === this.value;
  }
}

/** Synchronously admits one operation and prevents an old completion from releasing a newer one. */
export class PendingOperation {
  private sequence = 0;
  private active: number | null = null;

  begin(): number | null {
    if (this.active !== null) return null;
    this.sequence += 1;
    this.active = this.sequence;
    return this.active;
  }

  finish(operation: number): boolean {
    if (this.active !== operation) return false;
    this.active = null;
    return true;
  }

  cancel(): void {
    this.sequence += 1;
    this.active = null;
  }

  isCurrent(operation: number): boolean {
    return this.active === operation;
  }
}

export function shouldHydrateDraft(
  requestRevision: number,
  currentRevision: number,
  dirty: boolean,
  initialized: boolean
): boolean {
  return requestRevision === currentRevision && (!initialized || !dirty);
}

export function clearDraftIfUnchanged(current: string, submitted: string): string {
  return current === submitted ? "" : current;
}
