// Coverage warnings as badges (TIME-4, brief l.204, l.168; plan D100). Pure: the closed list of
// codes maps to the part of the interface each one qualifies, and the current `frames` slice is
// folded into one badge per code (the minor-body codes gather the objects they concern). The
// texts are the caller's (`t(\`warnings.${code}\`, params)`, plus `warnings.validRange` with the
// range as signed years).

import type { FramesState, SkyWarning, WarningCode } from './types';

export const WARNING_CODES: readonly WarningCode[] = [
  'iau_rotation_approximate',
  'pluto_barycenter',
  'delta_t_approximate',
  'proper_motion_extrapolated',
  'mpc_extrapolation',
  'mpc_unreliable',
];

/** Where a warning belongs: the time readout, the stars layer, the observer header, minor bodies. */
export type BadgeTarget = 'time' | 'stars' | 'observer' | 'minor';

export interface WarningBadge {
  code: WarningCode;
  target: BadgeTarget;
  params: Readonly<Record<string, number | string>> | undefined;
  rangeTt: readonly [number, number] | undefined;
  /** The minor bodies carrying the warning (empty for the other targets). */
  ids: readonly string[];
}

export function isWarningCode(value: string): value is WarningCode {
  return (WARNING_CODES as readonly string[]).includes(value);
}

export function targetOf(code: WarningCode): BadgeTarget {
  switch (code) {
    case 'delta_t_approximate':
      return 'time';
    case 'proper_motion_extrapolated':
      return 'stars';
    case 'iau_rotation_approximate':
    case 'pluto_barycenter':
      return 'observer';
    case 'mpc_extrapolation':
    case 'mpc_unreliable':
      return 'minor';
  }
}

function fold(
  badges: Map<WarningCode, WarningBadge>,
  warning: SkyWarning,
  id: string | null,
): void {
  const existing = badges.get(warning.code);
  if (existing === undefined) {
    badges.set(warning.code, {
      code: warning.code,
      target: targetOf(warning.code),
      params: warning.params,
      rangeTt: warning.rangeTt,
      ids: id === null ? [] : [id],
    });
    return;
  }
  if (id !== null && !existing.ids.includes(id)) {
    badges.set(warning.code, { ...existing, ids: [...existing.ids, id] });
  }
}

/**
 * One badge per warning code present in the current frame window, in the order of the closed
 * list: the observer and time warnings of the window, then the per-object minor-body warnings.
 */
export function badgesOf(frames: FramesState): WarningBadge[] {
  const badges = new Map<WarningCode, WarningBadge>();
  for (const warning of frames.warnings) {
    fold(badges, warning, null);
  }
  for (const status of frames.minor) {
    for (const warning of status.warnings) {
      fold(badges, warning, status.id);
    }
  }
  return WARNING_CODES.flatMap((code) => {
    const badge = badges.get(code);
    return badge === undefined ? [] : [badge];
  });
}
