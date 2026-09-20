export class HudBridge {
  constructor(
    native,
    sdk,
    {
      ackTimeoutMs = 5000,
      setTimer = setTimeout,
      clearTimer = clearTimeout,
    } = {},
  ) {
    if (
      !Number.isFinite(ackTimeoutMs) ||
      ackTimeoutMs <= 0 ||
      ackTimeoutMs > 2147483647
    )
      throw new RangeError("Invalid HUD ACK timeout");
    this.native = native;
    this.sdk = sdk;
    this.started = false;
    this._starting = null;
    this._inFlight = null;
    this._pending = null;
    this._audioPending = 0;
    this._audioQueue = Promise.resolve();
    this._active = true;
    this._generation = 0;
    this._lifecycleWork = Promise.resolve(true);
    this._ackTimeoutMs = ackTimeoutMs;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this.content = "CANVASTTY\nМикрофон не запущен";
    this.displayState = "unknown";
    this.acknowledgedContent = null;
  }
  startPage() {
    if (!this._active) return Promise.resolve(false);
    if (this.started) return Promise.resolve(true);
    if (this._starting) return this._starting;
    let resolve;
    const result = new Promise((done) => {
      resolve = done;
    });
    this._starting = result;
    this._send({ content: this.content, resolve, startup: true });
    return result;
  }
  microphone(on, { onDispatch = () => {}, canStart = () => true } = {}) {
    if (on && !this._active) return Promise.resolve(false);
    // Reserve the native channel before waiting for the current display write.
    // A frame requested during audioControl must not race the hardware ACK.
    this._audioPending++;
    const operation = this._audioQueue.then(async () => {
      await this.waitForIdle();
      if (on && (!this._active || !canStart())) return false;
      onDispatch();
      return this.native.audioControl(on, this.sdk.AudioInputSource.Glasses);
    });
    this._audioQueue = operation.catch(() => {});
    return operation.finally(() => {
      this._audioPending--;
      this._drain();
    });
  }
  async waitForIdle() {
    // Caller deadlines are not native settlement. Only done releases this barrier.
    while (this._inFlight) await this._inFlight.done;
  }
  suspend({ shutdown = false } = {}) {
    this._active = false;
    this._generation++;
    this.started = false;
    this._starting = null;
    this.displayState = "unknown";
    this.acknowledgedContent = null;
    this._settle(this._pending, false);
    this._pending = null;
    this._settle(this._inFlight, false);
    const previous = this._lifecycleWork;
    let resolve,
      expired = false;
    const result = new Promise((done) => {
      resolve = done;
    });
    const timer = this._setTimer(() => {
      expired = true;
      resolve(false);
    }, this._ackTimeoutMs);
    this._lifecycleWork = (async () => {
      const prior = await previous;
      await this.waitForIdle();
      let ok = prior;
      if (shutdown) {
        // One bounded attempt; no optimistic retry or release on timeout.
        const job = { shutdown: true };
        this._send(job);
        await job.done;
        ok = job.ok;
      }
      return ok === true && !expired;
    })();
    this._lifecycleWork.then((ok) => {
      this._clearTimer(timer);
      resolve(ok);
    });
    return result;
  }
  async reenter(content = "CANVASTTY\nМикрофон не запущен") {
    const generation = ++this._generation;
    this._active = false;
    this.started = false;
    this._starting = null;
    this._settle(this._pending, false);
    this._pending = null;
    this._settle(this._inFlight, false);
    const ok = await this._lifecycleWork;
    await this.waitForIdle();
    if (generation !== this._generation || ok !== true) return false;
    this._active = true;
    this.content = content;
    return this.startPage();
  }
  render(content) {
    if (!this._active || typeof content !== "string" || content.length > 4096)
      return Promise.resolve(false);
    this.content = content;
    if (!this.started) {
      if (this._starting) this._pending = { content, resolve: null };
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this._settle(this._pending, false);
      this._pending = { content, resolve };
      if (this._inFlight?.timedOut) this._settle(this._pending, false);
      this._drain();
    });
  }
  _settle(job, ok) {
    if (!job?.resolve) return;
    job.resolve(ok);
    job.resolve = null;
  }
  _drain() {
    if (
      !this._active ||
      !this.started ||
      this._inFlight ||
      this._audioPending ||
      !this._pending
    )
      return;
    const job = this._pending;
    this._pending = null;
    this._send(job);
  }
  _send(job) {
    job.generation = this._generation;
    let settled;
    job.done = new Promise((resolve) => {
      settled = resolve;
    });
    this._inFlight = job;
    this.displayState = "unknown";
    this.acknowledgedContent = null;
    const timer = this._setTimer(() => {
      job.timedOut = true;
      this._settle(job, false);
      this._settle(this._pending, false);
      // Native may still apply this frame. Keep the slot until its real settlement.
    }, this._ackTimeoutMs);
    const finish = (ok) => {
      this._clearTimer(timer);
      this._inFlight = null;
      const current = this._active && job.generation === this._generation;
      job.ok = ok && !job.timedOut && (job.shutdown || current);
      if (job.startup && current) {
        this.started = ok;
        this._starting = null;
        if (!ok) {
          this._settle(this._pending, false);
          this._pending = null;
        }
      }
      if (job.ok && !job.shutdown) {
        this.displayState = "confirmed";
        this.acknowledgedContent = job.content;
      }
      this._settle(job, job.ok);
      settled();
      this._drain();
    };
    try {
      const { content } = job;
      let result;
      if (job.shutdown) {
        result = this.native.shutDownPageContainer(1);
      } else if (job.startup) {
        const payload = new this.sdk.CreateStartUpPageContainer({
          containerTotalNum: 1,
          textObject: [
            new this.sdk.TextContainerProperty({
              xPosition: 8,
              yPosition: 0,
              width: 560,
              height: 288,
              containerID: 1,
              containerName: "canvastty-g2",
              isEventCapture: 1,
              content,
            }),
          ],
          menuObject: {
            menuItems: [
              { itemID: 1, itemName: "Home CanvasTTY" },
              { itemID: 2, itemName: "New Codex" },
              { itemID: 3, itemName: "New Terminal" },
              { itemID: 4, itemName: "Close Terminal" },
              { itemID: 5, itemName: "Project Browser" },
              { itemID: 6, itemName: "Rename Terminal" },
              { itemID: 7, itemName: "More agents" },
            ],
          },
        });
        result = this.native.createStartUpPageContainer(payload);
      } else {
        const payload = new this.sdk.TextContainerUpgrade({
          containerID: 1,
          containerName: "canvastty-g2",
          contentOffset: 0,
          contentLength: content.length,
          content,
        });
        result = this.native.textContainerUpgrade(payload);
      }
      Promise.resolve(result).then(
        (ack) => finish(job.startup ? ack === 0 : ack === true),
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  }
}
