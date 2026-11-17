// The six hand-authored showpiece systems of the Ember Reach, keyed by id. The galaxy layout
// (layout.ts) says where each one sits; sim/universe.ts builds them with the same `buildSystem`
// that builds every generated system.

import type { SystemSpec } from './spec';
import { TALLOW } from './tallow';
import { CHANCEL } from './chancel';
import { ORIFLAMME } from './oriflamme';
import { FATHOM } from './fathom';
import { FALSELIGHT } from './falselight';
import { AFTERGLOW } from './afterglow';

export const SHOWCASE_SYSTEMS: Readonly<Record<string, SystemSpec>> = {
  tallow: TALLOW,
  chancel: CHANCEL,
  oriflamme: ORIFLAMME,
  fathom: FATHOM,
  falselight: FALSELIGHT,
  afterglow: AFTERGLOW,
};
