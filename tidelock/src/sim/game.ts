// TIDELOCK game simulation: the one entry point the app needs.
//   const sim = loadGame(savedJson) ?? createGame({ seed: 1 });
//   each frame: sim.step(realDt); read the views; call the actions; listen to sim.events.
export { createGame, loadGame, Game } from './game/sim';
export * from './game/api';
export type { GameState, AssistState, BerthTransit, PlayerState, CargoLot } from './game/state';
export { TUG_RANGE, TUG_SPEED, CAPTURE_DISTANCE, CAPTURE_SPEED, START_CREDITS } from './game/state';
export { fmtDuration, fmtDistance } from './game/assist';
