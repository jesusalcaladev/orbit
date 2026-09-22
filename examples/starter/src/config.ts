/**
 * Configuration — the only module allowed to read `process.env`.
 *
 * Everything else receives a typed `Config`, so the rest of the project is
 * testable without touching the environment.
 */

export interface Config {
  /** TCP port for the node:http host. `0` picks an ephemeral port (tests). */
  port: number;
  /** HTTP path the protocol is served on. */
  path: string;
  /** Maximum relation nesting depth handed to `createOrbit`. */
  maxQueryDepth: number;
  /** Hard deadline per request, in ms (`undefined` disables it). */
  requestTimeoutMs: number | undefined;
}

function int(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 3000),
    path: env.ORBIT_PATH ?? '/orbit',
    maxQueryDepth: int(env.ORBIT_MAX_DEPTH, 10),
    requestTimeoutMs: env.ORBIT_TIMEOUT_MS ? int(env.ORBIT_TIMEOUT_MS, 5000) : undefined,
  };
}
