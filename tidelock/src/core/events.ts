// Minimal typed event bus. The simulation emits; UI, audio and rendering listen.
// Event names and payloads are declared by augmenting GameEvents (see src/sim/game.ts once it exists).

export type Handler<T> = (payload: T) => void;

export class EventBus<Events extends object> {
  private handlers = new Map<keyof Events, Set<Handler<any>>>();

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => this.off(type, handler);
  }

  off<K extends keyof Events>(type: K, handler: Handler<Events[K]>): void {
    this.handlers.get(type)?.delete(handler);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(payload);
      } catch (err) {
        console.error(`event handler for "${String(type)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
