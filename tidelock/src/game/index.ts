// The session: the one thing the client talks to (see api.ts and docs/ARCHITECTURE.md).
// TEMPORARY: until the physical world (src/world) lands, the session is an adapter over the old game facade.
// Swap the two factory imports below for the real session and delete legacySession.ts.
export * from './api';
export { createSession, loadSession } from './legacySession';
