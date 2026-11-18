import type { Session } from '../game';
import type { PerfMonitor } from '../app/perf';

/** What the app shell (src/app/app.ts) gives every screen. */
export interface UiHost {
  /** The running session: the only door to the simulation (src/game/api.ts). */
  session: Session;
  /** Full-screen DOM layer above the WebGL canvas. Screens append their root element here. */
  root: HTMLElement;
  /** Switch the top-level screen. */
  go(screen: 'title' | 'flight' | 'map'): void;
  /** Back to the starting orbit beside Chandler's Wheel with full tanks. */
  reset(): void;
  saveNow(): void;
  /** Sound hook; a no-op for now. */
  sfx(id: string): void;
  /** Persistent player settings. */
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  toast(message: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  /** Frame-time record and automatic quality (docs/ARCHITECTURE.md §5). */
  perf: PerfMonitor;
  perfVisible(): boolean;
  setPerfVisible(on: boolean): void;
}

/** A top-level screen or overlay. update() is called every frame while shown. */
export interface UiScreen {
  el: HTMLElement;
  show(): void;
  hide(): void;
  update(dt: number): void;
  dispose(): void;
}
