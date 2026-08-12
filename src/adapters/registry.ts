import type { DataAdapter } from './types.js';

/**
 * Maps entity names to their adapter. Duplicate entities are rejected at
 * registration time so mistakes surface at startup, not at request time.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, DataAdapter>();

  register(adapter: DataAdapter): this;
  register(adapters: DataAdapter[]): this;
  register(input: DataAdapter | DataAdapter[]): this {
    const list = Array.isArray(input) ? input : [input];
    for (const adapter of list) {
      if (!adapter || typeof adapter.entity !== 'string' || typeof adapter.resolve !== 'function') {
        throw new Error('Every adapter needs an "entity" name and a "resolve" function');
      }
      if (this.adapters.has(adapter.entity)) {
        throw new Error(`An adapter for entity '${adapter.entity}' is already registered`);
      }
      this.adapters.set(adapter.entity, adapter);
    }
    return this;
  }

  get(entity: string): DataAdapter | undefined {
    return this.adapters.get(entity);
  }

  /** All registered adapters, in registration order. */
  get list(): DataAdapter[] {
    return [...this.adapters.values()];
  }
}
