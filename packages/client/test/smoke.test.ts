import { describe, expect, it } from 'vitest';

describe('@orbit/client', () => {
  it('module loads (M0 skeleton)', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeTypeOf('object');
  });
});
