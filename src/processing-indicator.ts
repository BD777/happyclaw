export function processingIndicatorKey(
  route: string,
  inputMessageId: string,
): string {
  return `${route}\0${inputMessageId}`;
}

interface AsyncIndicatorEntry<Handle> {
  ready: Promise<Handle | null>;
  release: (handle: Handle) => Promise<void>;
  clearPromise?: Promise<void>;
}

/**
 * Owns provider resources by an exact logical input.
 *
 * The entry is installed before `acquire` starts. Consequently a terminal
 * clear that races an in-flight provider attach waits for that attach and
 * releases the resulting handle exactly once.
 */
export class ExactAsyncIndicatorRegistry<Handle> {
  private readonly entries = new Map<string, AsyncIndicatorEntry<Handle>>();

  attach(
    key: string,
    acquire: () => Promise<Handle | null>,
    release: (handle: Handle) => Promise<void>,
  ): Promise<void> {
    const existing = this.entries.get(key);
    if (existing) return existing.ready.then(() => undefined);

    const entry: AsyncIndicatorEntry<Handle> = {
      ready: Promise.resolve().then(acquire),
      release,
    };
    this.entries.set(key, entry);

    return entry.ready
      .then(() => undefined)
      .catch((error) => {
        // Acquisition failed, so there is no provider handle to retain even
        // when a racing clear is already waiting on this promise.
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
        throw error;
      });
  }

  clear(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    if (entry.clearPromise) return entry.clearPromise;

    entry.clearPromise = entry.ready
      .then(async (handle) => {
        if (handle) await entry.release(handle);
      })
      .then(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      })
      .catch((error) => {
        // A provider delete can fail transiently. Retain ownership and allow a
        // later terminal/shutdown cleanup to retry instead of orphaning the
        // reaction handle permanently.
        entry.clearPromise = undefined;
        throw error;
      });
    return entry.clearPromise;
  }

  async clearAll(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.keys()].map((key) => this.clear(key)),
    );
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
