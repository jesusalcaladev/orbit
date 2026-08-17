/**
 * `<OrbitProvider>` — makes a react client available to every hook in the
 * tree, and `useOrbitClient()` — access to the imperative cache API.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { OrbitReactClient } from './client.js';

const OrbitContext = createContext<OrbitReactClient | null>(null);

export interface OrbitProviderProps {
  client: OrbitReactClient;
  children: ReactNode;
}

export function OrbitProvider({ client, children }: OrbitProviderProps): ReactNode {
  return <OrbitContext.Provider value={client}>{children}</OrbitContext.Provider>;
}

/** The react client from the nearest `<OrbitProvider>`. */
export function useOrbitClient(): OrbitReactClient {
  const client = useContext(OrbitContext);
  if (client === null) {
    throw new Error('useOrbitClient must be used within an <OrbitProvider>.');
  }
  return client;
}
