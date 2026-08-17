import { describe, expect, it } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import { OrbitProvider, useOrbitClient } from '../src/provider.js';
import { fakeTransport, reactClientOf } from './helpers.js';

describe('OrbitProvider / useOrbitClient', () => {
  it('provides the react client to the subtree', () => {
    const client = reactClientOf(fakeTransport().transport);
    const probe = renderHook(() => useOrbitClient(), {
      wrapper: ({ children }) => <OrbitProvider client={client}>{children}</OrbitProvider>,
    });
    expect(probe.result.current).toBe(client);
  });

  it('renders children', () => {
    const client = reactClientOf(fakeTransport().transport);
    render(
      <OrbitProvider client={client}>
        <div>hello orbit</div>
      </OrbitProvider>,
    );
    expect(screen.getByText('hello orbit')).toBeDefined();
  });

  it('throws when used outside a provider', () => {
    expect(() => renderHook(() => useOrbitClient())).toThrow(/OrbitProvider/);
  });
});
