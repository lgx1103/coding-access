/** Scheduling is independent of provider protocol and persistence. A lease reserves
 * capacity before dispatch, so concurrent requests observe each other's load. */
export interface Candidate {
  id: string; providerId: string; providerWeight: number; keyWeight: number;
  maxConcurrent: number; group?: string;
}
interface Load { work: number; at: number; pending: number; inFlight: number }
export interface Lease { candidate: Candidate; release: (actualWork?: number) => void }

export class AdaptivePool {
  private providers = new Map<string, Load>();
  private keys = new Map<string, Load>();
  private groups = new Map<string, number>();
  private now: () => number;
  readonly startedAt: number;
  private peaks: { at: number; active: number }[] = [];
  constructor(private halfLifeMs = 60_000, now = Date.now) { this.now = now; this.startedAt = now(); }
  live() {
    const at = this.now();
    this.peaks = this.peaks.filter(p => p.at > at - 300_000);
    const active = [...this.keys.values()].reduce((n, s) => n + s.inFlight, 0);
    return { active, peak: Math.max(active, 0, ...this.peaks.map(p => p.active)), startedAt: this.startedAt };
  }

  private state(map: Map<string, Load>, id: string): Load {
    const now = this.now();
    let value = map.get(id);
    if (!value) { value = { work: 0, at: now, pending: 0, inFlight: 0 }; map.set(id, value); }
    value.work *= Math.pow(0.5, Math.max(0, now - value.at) / this.halfLifeMs);
    value.at = now;
    return value;
  }

  acquire(candidates: Candidate[], estimatedWork = 1): Lease | null {
    const estimate = Math.max(1, estimatedWork);
    const ready = candidates.filter(c => {
      const key = this.state(this.keys, c.id);
      return key.inFlight < c.maxConcurrent && (!c.group || (this.groups.get(c.group) ?? 0) < c.maxConcurrent);
    });
    if (!ready.length) return null;
    const providers = [...new Set(ready.map(c => c.providerId))];
    const providerScore = (id: string) => {
      const options = ready.filter(c => c.providerId === id);
      const s = this.state(this.providers, id);
      // The cost of this incoming job is included. This preserves weighted sharing
      // even with idle providers, while pending work diverts traffic BEFORE a 429.
      return (s.work + s.pending + estimate) / options[0].providerWeight;
    };
    providers.sort((a, b) => providerScore(a) - providerScore(b));
    const options = ready.filter(c => c.providerId === providers[0]);
    const keyScore = (c: Candidate) => {
      const s = this.state(this.keys, c.id);
      return (s.work + s.pending + estimate) / c.keyWeight;
    };
    options.sort((a, b) => keyScore(a) - keyScore(b));
    const candidate = options[0];
    const provider = this.state(this.providers, candidate.providerId);
    const key = this.state(this.keys, candidate.id);
    for (const s of [provider, key]) { s.pending += estimate; s.inFlight++; }
    const live = this.live();
    // One maximum per second bounds memory even under a burst of requests.
    const at = Math.floor(this.now() / 1000) * 1000;
    const last = this.peaks.at(-1);
    if (last?.at === at) last.active = Math.max(last.active, live.active);
    else this.peaks.push({ at, active: live.active });
    if (candidate.group) this.groups.set(candidate.group, (this.groups.get(candidate.group) ?? 0) + 1);
    let done = false;
    return { candidate, release: (actualWork = estimate) => {
      if (done) return;
      done = true;
      for (const [map, id] of [[this.providers, candidate.providerId], [this.keys, candidate.id]] as const) {
        const s = this.state(map, id);
        s.pending = Math.max(0, s.pending - estimate); s.inFlight--;
        s.work += Math.max(0, actualWork);
      }
      if (candidate.group) this.groups.set(candidate.group, Math.max(0, (this.groups.get(candidate.group) ?? 0) - 1));
    } };
  }

  active(keyId: string) { return this.state(this.keys, keyId).inFlight; }
  snapshot() {
    return [...this.providers.keys()].map(id => ({ id, ...this.state(this.providers, id) }));
  }
}

interface Waiting { user: string; resolve: (release: () => void) => void; reject: (e: Error) => void; signal: AbortSignal; cancel: () => void }
/** Round-robin admission between employees, with finite concurrent work. */
export class FairQueue {
  private waiting = new Map<string, Waiting[]>();
  private rotation: string[] = [];
  private activeUsers = new Map<string, number>();
  private active = 0;
  constructor(private capacity = 16, private perUser = 3, private maxQueued = 200) {}
  enter(user: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('请求已取消或等待超时'));
    if ([...this.waiting.values()].reduce((n, q) => n + q.length, 0) >= this.maxQueued) return Promise.reject(new Error('请求队列已满，请稍后重试'));
    return new Promise((resolve, reject) => {
      const item: Waiting = { user, resolve, reject, signal, cancel: () => {
        const q = this.waiting.get(user);
        if (q) { const i = q.indexOf(item); if (i >= 0) q.splice(i, 1); }
        this.clean(user); reject(new Error('请求已取消或等待超时')); this.drain();
      } };
      if (!this.waiting.has(user)) { this.waiting.set(user, []); this.rotation.push(user); }
      this.waiting.get(user)!.push(item);
      signal.addEventListener('abort', item.cancel, { once: true });
      this.drain();
    });
  }
  private clean(user: string) {
    if (!this.waiting.get(user)?.length) {
      this.waiting.delete(user); this.rotation = this.rotation.filter(x => x !== user);
    }
  }
  private drain() {
    let skipped = 0;
    while (this.active < this.capacity && this.rotation.length && skipped < this.rotation.length) {
      const user = this.rotation.shift()!; this.rotation.push(user);
      if ((this.activeUsers.get(user) ?? 0) >= this.perUser) { skipped++; continue; }
      skipped = 0;
      const item = this.waiting.get(user)!.shift()!; this.clean(user);
      item.signal.removeEventListener('abort', item.cancel);
      this.active++; this.activeUsers.set(user, (this.activeUsers.get(user) ?? 0) + 1);
      let done = false;
      item.resolve(() => {
        if (done) return; done = true;
        this.active--; this.activeUsers.set(user, (this.activeUsers.get(user) ?? 1) - 1);
        this.drain();
      });
    }
  }
  get queued() { return [...this.waiting.values()].reduce((n, q) => n + q.length, 0); }
}
