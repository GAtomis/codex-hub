export type EventMessage = Record<string, unknown>;

type Listener = (event: EventMessage) => void;

class EventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: EventMessage): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export const eventBus = new EventBus();
