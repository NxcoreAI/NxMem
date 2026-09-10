export interface DreamingOwnerScope {
  tenantId: string;
  principalId: string;
}

export interface ForegroundActivityGateOptions {
  resumeIdleAfterMs?: number;
  onBecameActive?: (owner: DreamingOwnerScope) => void | Promise<void>;
  onBecameIdle?: (owner: DreamingOwnerScope) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

interface OwnerActivityState {
  leaseCount: number;
}

/** Global foreground leases used to preempt the single Dreaming worker and later resume work. */
export class ForegroundActivityGate {
  private readonly states = new Map<string, OwnerActivityState>();
  private readonly resumeIdleAfterMs: number;
  private readonly onBecameActive?: ForegroundActivityGateOptions["onBecameActive"];
  private readonly onBecameIdle?: ForegroundActivityGateOptions["onBecameIdle"];
  private readonly onError: (error: unknown) => void;
  private totalLeaseCount = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(options: ForegroundActivityGateOptions = {}) {
    this.resumeIdleAfterMs = options.resumeIdleAfterMs ?? 120_000;
    this.onBecameActive = options.onBecameActive;
    this.onBecameIdle = options.onBecameIdle;
    this.onError = options.onError ?? (() => undefined);
  }

  async acquire(owner: DreamingOwnerScope) {
    assertOwner(owner);
    const key = ownerKey(owner);
    const state = this.states.get(key) ?? { leaseCount: 0 };
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      delete this.idleTimer;
    }
    const becameActive = this.totalLeaseCount === 0;
    state.leaseCount += 1;
    this.totalLeaseCount += 1;
    this.states.set(key, state);
    if (becameActive) {
      try {
        await this.onBecameActive?.(owner);
      } catch (error) {
        this.onError(error);
      }
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(owner);
    };
  }

  async run<T>(owner: DreamingOwnerScope, callback: () => Promise<T>) {
    const release = await this.acquire(owner);
    try {
      return await callback();
    } finally {
      release();
    }
  }

  isActive(_owner?: DreamingOwnerScope) {
    return this.totalLeaseCount > 0;
  }

  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    delete this.idleTimer;
    this.totalLeaseCount = 0;
    this.states.clear();
  }

  private release(owner: DreamingOwnerScope) {
    const key = ownerKey(owner);
    const state = this.states.get(key);
    if (!state) return;
    state.leaseCount = Math.max(0, state.leaseCount - 1);
    this.totalLeaseCount = Math.max(0, this.totalLeaseCount - 1);
    if (state.leaseCount === 0) this.states.delete(key);
    if (this.totalLeaseCount > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.totalLeaseCount > 0) return;
      delete this.idleTimer;
      Promise.resolve(this.onBecameIdle?.(owner)).catch(this.onError);
    }, this.resumeIdleAfterMs);
    this.idleTimer.unref?.();
  }
}

export function dreamingOwnerKey(owner: DreamingOwnerScope) {
  return ownerKey(owner);
}

function ownerKey(owner: DreamingOwnerScope) {
  return `${owner.tenantId}\u0000${owner.principalId}`;
}

function assertOwner(owner: DreamingOwnerScope) {
  if (!owner.tenantId.trim() || !owner.principalId.trim()) {
    throw new Error("DREAMING_OWNER_REQUIRED");
  }
}
