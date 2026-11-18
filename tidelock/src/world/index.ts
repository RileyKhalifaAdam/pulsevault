// TIDELOCK — the physical world (docs/ARCHITECTURE.md §3). Pure TypeScript: no DOM, no three.js, deterministic.
//
// Typical use (the session layer):
//   const world = createWorld(system);                       // bodies + stations at t = 0
//   const ship = addCraft(world, shipDef('player', 'Wren', stats, SHIP_LAYOUTS.wren, { primaryId, r, v }));
//   ship.throttle = 1; ship.torque.x = 0.3; ship.dockingArmed = true;   // commands are plain fields on the craft
//   holdTorque(pointingError(ship.q, dir, e), ship.w, craftInertia(ship, I), ship.maxTorque, ship.torque);
//   const { simDt, steps, limitedBy } = advance(world, realDt * warp, { budgetMs: 3 });
//   for (const e of drainEvents(world)) …                    // docked, undocked, impact, destroyed, atmosphere, …
//   predict(world, ship.id, { duration, burns, targetCraftId }, prediction);   // or Predictor.start()/run(ms)
//   flightReadout(world, ship.id); dockingStatus(world, ship.id); undock(world, ship.id);
//   const json = saveWorld(world); const again = loadWorld(json);       // continues bit-identically
//
// State of record: bodies live in the ephemeris (world.bodies[i].r/v/spinAngle are refreshed at world.t by
// advance); a craft's integrated state is `rel`/`relV` relative to `primary`, with barycentric `r`/`v` derived.

export * from './state';
export * from './setup';
export * from './ephemeris';
export * from './dynamics';
export * from './control';
export * from './atmosphere';
export * from './contact';
export * from './elements';
export * from './predict';
export * from './world';
export { qRot, qRotInv, qMulTo, qAxisTo, rotAxis } from './math';
