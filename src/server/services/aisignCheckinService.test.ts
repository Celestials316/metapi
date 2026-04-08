import { describe, expect, it } from 'vitest';
import { parseAisignChallengePayload } from './aisignCheckinService.js';

describe('aisignCheckinService', () => {
  it('accepts string challenge ids returned by aisign challenge api', () => {
    expect(parseAisignChallengePayload({
      challengeId: 'f206a987-1a09-44c7-82f8-4442b9656557',
      challenge: '36d4725b-5280-4c0e-93f3-d3fe58156ec4',
      difficulty: 13,
    })).toEqual({
      challengeId: 'f206a987-1a09-44c7-82f8-4442b9656557',
      challenge: '36d4725b-5280-4c0e-93f3-d3fe58156ec4',
      difficulty: 13,
    });
  });
});
