import { describe, expect, test } from 'vitest';

import { isHappyClawBootstrapTurn } from '../src/happyclaw-bootstrap.js';

describe('HappyClaw first-wake eligibility', () => {
  test('allows only a real interactive Home turn of the built-in profile', () => {
    expect(
      isHappyClawBootstrapTurn({
        turnId: 'owner-turn',
        isHome: true,
        isDefaultProfile: true,
      }),
    ).toBe(true);
    expect(
      isHappyClawBootstrapTurn({
        isHome: true,
        isDefaultProfile: true,
      }),
    ).toBe(false);
    expect(
      isHappyClawBootstrapTurn({
        turnId: 'scheduled-turn',
        isHome: true,
        isDefaultProfile: true,
        isScheduledTask: true,
      }),
    ).toBe(false);
    expect(
      isHappyClawBootstrapTurn({
        turnId: 'custom-turn',
        isHome: true,
        isDefaultProfile: false,
      }),
    ).toBe(false);
    expect(
      isHappyClawBootstrapTurn({
        turnId: 'project-turn',
        isHome: false,
        isDefaultProfile: true,
      }),
    ).toBe(false);
  });
});
