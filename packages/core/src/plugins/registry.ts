import type { OrbitPlugin } from './types.js';

/**
 * Holds the plugins mounted on an Orbit engine, in registration order.
 * Hooks run in this exact order at every stage of the pipeline.
 */
export class PluginRegistry {
  private readonly plugins: OrbitPlugin[] = [];
  private readonly names = new Set<string>();

  register(plugin: OrbitPlugin): this;
  register(plugins: OrbitPlugin[]): this;
  register(input: OrbitPlugin | OrbitPlugin[]): this {
    const list = Array.isArray(input) ? input : [input];
    for (const plugin of list) {
      if (!plugin || typeof plugin.name !== 'string' || plugin.name.length === 0 || !plugin.hooks) {
        throw new Error('Every plugin needs a non-empty "name" and a "hooks" object');
      }
      if (this.names.has(plugin.name)) {
        throw new Error(`Plugin '${plugin.name}' is already registered`);
      }
      this.names.add(plugin.name);
      this.plugins.push(plugin);
    }
    return this;
  }

  /** Plugins in registration order. */
  get list(): readonly OrbitPlugin[] {
    return this.plugins;
  }
}
