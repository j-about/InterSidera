// @vitest-environment node

import type { FramesState, MinorStatus, SkyWarning } from './types';
import { WARNING_CODES, badgesOf, isWarningCode, targetOf } from './warnings';

// The TIME-4 badges: every code has a home, the frame window's warnings fold into one badge per
// code, the minor-body warnings gather the objects they concern.

function frames(warnings: SkyWarning[], minor: MinorStatus[] = []): FramesState {
  return {
    status: 'ready',
    window: null,
    snapshot: false,
    extrapolating: false,
    warnings,
    lastError: null,
    failing: null,
    coverageStop: null,
    minor,
  };
}

function minor(id: string, warnings: SkyWarning[]): MinorStatus {
  return {
    id,
    kind: 'asteroid',
    elementsEpochTt: 2460200.5,
    extrapolationYears: 3,
    warnings,
    drawn: true,
  };
}

describe('warnings', () => {
  it('recognises the closed list and maps each code to its target', () => {
    expect(WARNING_CODES).toHaveLength(6);
    for (const code of WARNING_CODES) {
      expect(isWarningCode(code)).toBe(true);
    }
    expect(isWarningCode('something_else')).toBe(false);
    expect(targetOf('delta_t_approximate')).toBe('time');
    expect(targetOf('proper_motion_extrapolated')).toBe('stars');
    expect(targetOf('iau_rotation_approximate')).toBe('observer');
    expect(targetOf('pluto_barycenter')).toBe('observer');
    expect(targetOf('mpc_extrapolation')).toBe('minor');
    expect(targetOf('mpc_unreliable')).toBe('minor');
  });

  it('folds the window and minor-body warnings into ordered badges', () => {
    const range: [number, number] = [2441317.5, 2461349.5];
    const state = frames(
      [
        { code: 'proper_motion_extrapolated', params: { years: 10000 }, rangeTt: range },
        { code: 'delta_t_approximate', rangeTt: range },
        { code: 'delta_t_approximate' },
      ],
      [
        minor('a:1', [{ code: 'mpc_extrapolation', params: { years: 3.5 } }]),
        minor('c:1P', [
          { code: 'mpc_extrapolation', params: { years: 60 } },
          { code: 'mpc_unreliable', params: { years: 60 } },
        ]),
        minor('a:1', [{ code: 'mpc_extrapolation', params: { years: 3.5 } }]),
      ],
    );
    const badges = badgesOf(state);
    expect(badges.map((b) => b.code)).toEqual([
      'delta_t_approximate',
      'proper_motion_extrapolated',
      'mpc_extrapolation',
      'mpc_unreliable',
    ]);
    expect(badges[0]).toEqual({
      code: 'delta_t_approximate',
      target: 'time',
      params: undefined,
      rangeTt: range,
      ids: [],
    });
    expect(badges[1]?.params).toEqual({ years: 10000 });
    expect(badges[2]).toMatchObject({
      target: 'minor',
      ids: ['a:1', 'c:1P'],
      params: { years: 3.5 },
    });
    expect(badges[3]).toMatchObject({ target: 'minor', ids: ['c:1P'] });
  });

  it('is empty without warnings', () => {
    expect(badgesOf(frames([]))).toEqual([]);
  });
});
