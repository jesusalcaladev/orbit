import { describe, expect, it } from 'vitest';

describe('@orbit/client', () => {
  it('module loads (M0 skeleton)', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeTypeOf('object');
    // The dynamic import pulls in the whole package graph; on a cold
    // transform under parallel test load it can exceed Vitest's 5 s default
    // and fail as a false negative. The assertion is about the module
    // resolving, not about how fast the transform is.
  }, 30_000);
});
