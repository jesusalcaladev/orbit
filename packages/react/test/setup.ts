/**
 * Vitest runs without globals, so @testing-library/react cannot auto-register
 * its per-test cleanup. Register it explicitly — otherwise renders accumulate
 * across tests and text queries match multiple elements.
 */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
