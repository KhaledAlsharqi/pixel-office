// Answers from employees that run at the same time, shared by the group chats and the advisory council: at most PARALLEL at
// once across the office, so a computer running Hermes (and subscriptions several agents share) is not hit by a dozen at once.
export const PARALLEL = 3;

class Slots {
  private free = PARALLEL;
  private waiting: Array<() => void> = [];
  async take(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiting.push(r));
    let done = false;
    return () => { if (done) return; done = true; const next = this.waiting.shift(); if (next) next(); else this.free++; };
  }
}
export const slots = new Slots();
