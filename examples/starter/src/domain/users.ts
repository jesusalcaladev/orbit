/**
 * Domain layer — users.
 *
 * Pure TypeScript: the entity and an in-memory repository. This module knows
 * nothing about Orbit, HTTP or frameworks — replace the repository with a
 * database client later and nothing else in the project changes shape.
 */

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
}

/** Seed data so the starter runs out of the box — swap for your real source. */
export function seedUsers(): User[] {
  return [
    { id: '1', name: 'Ana', email: 'ana@orbit.dev', role: 'admin' },
    { id: '2', name: 'Bruno', email: 'bruno@orbit.dev', role: 'member' },
  ];
}

/**
 * In-memory repository: the single owner of user data. Every method returns
 * fresh copies, so callers can never mutate the store by accident.
 */
export class UserRepository {
  private readonly users = new Map<string, User>();

  constructor(seed: User[] = seedUsers()) {
    for (const user of seed) this.users.set(user.id, { ...user });
  }

  byId(id: string): User | null {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  all(): User[] {
    return [...this.users.values()].map((user) => ({ ...user }));
  }
}
