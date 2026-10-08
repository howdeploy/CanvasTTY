export interface InspectorLoadRequest<Tab extends string = string> {
  tab: Tab;
  cursor?: string;
}

/** Keeps one in-flight inspector read and remembers only the newest relevant follow-up. */
export class InspectorLoadGate<Tab extends string = string> {
  private busy = false;
  private pending: InspectorLoadRequest<Tab> | null = null;

  begin(request: InspectorLoadRequest<Tab>, queueWhenBusy: boolean): boolean {
    if (this.busy) {
      if (queueWhenBusy) this.pending = request;
      return false;
    }
    this.busy = true;
    return true;
  }

  finish(): InspectorLoadRequest<Tab> | null {
    this.busy = false;
    const request = this.pending;
    this.pending = null;
    return request;
  }

  cancel(): void {
    this.busy = false;
    this.pending = null;
  }
}
