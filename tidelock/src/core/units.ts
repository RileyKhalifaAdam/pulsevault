// Physical constants and human-readable formatting. The simulation is SI throughout.

export const G = 6.6743e-11; // m^3 kg^-1 s^-2
export const G0 = 9.80665; // m/s^2, standard gravity (Isp <-> exhaust velocity)
export const AU = 1.495978707e11; // m
export const LIGHT_YEAR = 9.4607e15; // m
export const SOLAR_MASS = 1.98847e30; // kg
export const SOLAR_RADIUS = 6.957e8; // m
export const EARTH_MASS = 5.9722e24; // kg
export const EARTH_RADIUS = 6.371e6; // m
export const JUPITER_MASS = 1.89813e27; // kg
export const JUPITER_RADIUS = 6.9911e7; // m
export const MINUTE = 60;
export const HOUR = 3600;
export const DAY = 86400;
export const YEAR = 365.25 * DAY;
export const DEG = Math.PI / 180;

/** The in-fiction calendar starts here: sim time 0 = 1 January 2907, 00:00. */
export const EPOCH_YEAR = 2907;

const trim = (n: number, digits: number): string => {
  const s = n.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

/** 1234 -> "1,234" */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Distance in metres -> "850 m", "12.4 km", "3,410 km", "1.52 Mm"… chooses m / km / Mm / Gm / AU. */
export function fmtDistance(m: number): string {
  const a = Math.abs(m);
  if (!Number.isFinite(m)) return '—';
  if (a < 1000) return `${trim(m, a < 10 ? 1 : 0)} m`;
  if (a < 1e5) return `${trim(m / 1e3, a < 1e4 ? 2 : 1)} km`;
  if (a < 1e7) return `${fmtInt(m / 1e3)} km`;
  if (a < 1e9) return `${trim(m / 1e6, a < 1e8 ? 2 : 1)} Mm`;
  if (a < 1.5e10) return `${trim(m / 1e9, 2)} Gm`;
  return `${trim(m / AU, 3)} AU`;
}

/** Speed in m/s -> "4.2 m/s", "312 m/s", "7.61 km/s". */
export function fmtSpeed(v: number): string {
  const a = Math.abs(v);
  if (!Number.isFinite(v)) return '—';
  if (a < 10) return `${trim(v, 2)} m/s`;
  if (a < 1000) return `${trim(v, a < 100 ? 1 : 0)} m/s`;
  return `${trim(v / 1000, a < 1e5 ? 2 : 1)} km/s`;
}

/** Duration in seconds -> "42s", "3m 05s", "2h 14m", "5d 03h", "2y 113d". */
export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const sign = s < 0 ? '-' : '';
  let t = Math.abs(s);
  if (t < 60) return `${sign}${Math.floor(t)}s`;
  if (t < HOUR) return `${sign}${Math.floor(t / 60)}m ${String(Math.floor(t % 60)).padStart(2, '0')}s`;
  if (t < DAY) return `${sign}${Math.floor(t / HOUR)}h ${String(Math.floor((t % HOUR) / 60)).padStart(2, '0')}m`;
  if (t < YEAR) return `${sign}${Math.floor(t / DAY)}d ${String(Math.floor((t % DAY) / HOUR)).padStart(2, '0')}h`;
  const y = Math.floor(t / YEAR);
  t -= y * YEAR;
  return `${sign}${y}y ${Math.floor(t / DAY)}d`;
}

/** Mass in kg -> "820 kg", "12.4 t", "1,250 t". */
export function fmtMass(kg: number): string {
  const a = Math.abs(kg);
  if (a < 1000) return `${trim(kg, 0)} kg`;
  if (a < 1e5) return `${trim(kg / 1000, a < 1e4 ? 2 : 1)} t`;
  return `${fmtInt(kg / 1000)} t`;
}

/** Credits -> "1,250 cr", "1.25M cr" for large sums when `short` is set. */
export function fmtCredits(cr: number, short = false): string {
  const a = Math.abs(cr);
  if (short && a >= 1e9) return `${trim(cr / 1e9, 2)}B cr`;
  if (short && a >= 1e6) return `${trim(cr / 1e6, 2)}M cr`;
  if (short && a >= 1e4) return `${trim(cr / 1e3, 1)}k cr`;
  return `${fmtInt(cr)} cr`;
}

/** Signed percentage: 0.034 -> "+3.4%". */
export function fmtPercent(x: number, digits = 1, signed = false): string {
  const s = trim(x * 100, digits);
  return `${signed && x > 0 ? '+' : ''}${s}%`;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Sim time (seconds since epoch) -> "14 MAR 2907 · 08:42". Uses a 365-day year of real months. */
export function fmtDate(t: number, withTime = true): string {
  const days = Math.floor(t / DAY);
  const year = EPOCH_YEAR + Math.floor(days / 365);
  let d = days % 365;
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let month = 0;
  while (d >= lengths[month]) {
    d -= lengths[month];
    month++;
  }
  const date = `${d + 1} ${MONTHS[month]} ${year}`;
  if (!withTime) return date;
  const secs = ((t % DAY) + DAY) % DAY;
  const hh = String(Math.floor(secs / HOUR)).padStart(2, '0');
  const mm = String(Math.floor((secs % HOUR) / 60)).padStart(2, '0');
  return `${date} · ${hh}:${mm}`;
}
