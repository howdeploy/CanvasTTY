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

export function shouldHydrateDraft(
  requestRevision: number,
  currentRevision: number,
  dirty: boolean,
  initialized: boolean
): boolean {
  return requestRevision === currentRevision && (!initialized || !dirty);
}

