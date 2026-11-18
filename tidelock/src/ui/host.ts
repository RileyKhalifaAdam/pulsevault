import type { GameSim } from '../sim/game';

/** What the app shell (src/main.ts) gives every screen. */
export interface UiHost {
  /** The running game. Replaced on new game / load: always read host.game, never cache it. */
  game: GameSim;
  /** Full-screen DOM layer above the WebGL canvas. Screens append their root element here. */
  root: HTMLElement;
  /** Switch the top-level screen. */
  go(screen: 'title' | 'station' | 'flight' | 'map'): void;
  newGame(): void;
  /** Loads the saved game; false when there is none or it is unreadable. */
  continueGame(): boolean;
  hasSave(): boolean;
  saveNow(): void;
  /** Sound hook; a no-op for now. */
  sfx(id: string): void;
  /** Persistent player settings. */
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  toast(message: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
}

/** A top-level screen or overlay. update() is called every frame while shown. */
export interface UiScreen {
  el: HTMLElement;
  show(): void;
  hide(): void;
  update(dt: number): void;
  dispose(): void;
}
