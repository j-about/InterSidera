// @vitest-environment node
import { DEFAULT_RETRY_AFTER_S, MAX_RETRY_AFTER_S, createRateGate } from './rateGate';

describe('createRateGate', () => {
  it('allows everything until a 429 blocks it for Retry-After seconds', () => {
    const gate = createRateGate();
    expect(gate.allowed(0)).toBe(true);
    expect(gate.blockedUntilMs()).toBe(-Infinity);
    gate.block(3, 1000);
    expect(gate.allowed(1000)).toBe(false);
    expect(gate.allowed(3999)).toBe(false);
    expect(gate.allowed(4000)).toBe(true);
    expect(gate.blockedUntilMs()).toBe(4000);
  });

  it('defaults a missing Retry-After to one second and caps a long one', () => {
    const gate = createRateGate();
    gate.block(undefined, 0);
    expect(gate.blockedUntilMs()).toBe(DEFAULT_RETRY_AFTER_S * 1000);
    gate.block(NaN, 0);
    expect(gate.blockedUntilMs()).toBe(DEFAULT_RETRY_AFTER_S * 1000);
    gate.block(3600, 0);
    expect(gate.blockedUntilMs()).toBe(MAX_RETRY_AFTER_S * 1000);
    gate.block(-5, 0);
    expect(gate.blockedUntilMs()).toBe(MAX_RETRY_AFTER_S * 1000);
  });

  it('never shortens an existing block', () => {
    const gate = createRateGate();
    gate.block(10, 0);
    gate.block(1, 0);
    expect(gate.blockedUntilMs()).toBe(10_000);
  });
});
