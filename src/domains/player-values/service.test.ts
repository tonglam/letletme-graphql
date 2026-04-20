import { describe, expect, it } from 'bun:test';
import { calculatePriceChangeType } from './service';

describe('calculatePriceChangeType', () => {
  it('returns RISE when newValue is greater than oldValue', () => {
    expect(calculatePriceChangeType(99, 100)).toBe('RISE');
  });

  it('returns FALL when newValue is less than oldValue', () => {
    expect(calculatePriceChangeType(100, 99)).toBe('FALL');
  });

  it('returns UNCHANGED when values are equal', () => {
    expect(calculatePriceChangeType(100, 100)).toBe('UNCHANGED');
  });
});
