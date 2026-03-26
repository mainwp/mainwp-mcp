/**
 * Security Unit Tests
 *
 * Tests for input validation in security.ts.
 */

import { describe, it, expect } from 'vitest';
import { validateInput } from '../../src/security.js';

describe('validateInput', () => {
  describe('plural ID fields (_ids)', () => {
    it('accepts a valid array of numeric IDs', () => {
      expect(() => validateInput({ site_ids: [1, 2, 3] })).not.toThrow();
    });

    it('accepts a valid array of numeric string IDs', () => {
      expect(() => validateInput({ site_ids: ['1', '2', '3'] })).not.toThrow();
    });

    it('rejects non-array values', () => {
      expect(() => validateInput({ site_ids: '123' })).toThrow('"site_ids" must be an array');
      expect(() => validateInput({ site_ids: 123 })).toThrow('"site_ids" must be an array');
      expect(() => validateInput({ site_ids: { id: 1 } })).toThrow('"site_ids" must be an array');
    });

    it('rejects non-integer numeric strings', () => {
      expect(() => validateInput({ site_ids: ['1.5'] })).toThrow('positive integer');
    });

    it('rejects strings with trailing non-numeric characters', () => {
      expect(() => validateInput({ site_ids: ['1abc'] })).toThrow('positive integer');
    });

    it('rejects zero and negative IDs', () => {
      expect(() => validateInput({ site_ids: [0] })).toThrow('positive integer');
      expect(() => validateInput({ site_ids: [-1] })).toThrow('positive integer');
    });
  });
});
