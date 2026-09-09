// The label text resolver the shell hands to the engine (plan D93): the engine imports no
// i18next, so a `LabelTextKey` names what is drawn and this module turns it into the current
// language. The template keys keep a literal prefix so `scripts/check_i18n.mjs` can match them
// (rules/frontend.md); a key that is not translated yet shows its raw id rather than nothing.

import i18next from 'i18next';

import type { LabelTextKey } from '../sky/engine/types';

export function labelText(key: LabelTextKey): string {
  switch (key.kind) {
    case 'constellation':
      return i18next.t(`constellations.${key.abbr}`, { defaultValue: key.abbr });
    case 'body':
      return i18next.t(`bodies.${key.id}`, { defaultValue: key.id });
    case 'cardinal':
      return i18next.t(`cardinal.${key.letter}`, { defaultValue: key.letter.toUpperCase() });
  }
}
