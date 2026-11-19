// Hybrid ray-traced sunlight for the ship interior (iPhone 15 / WebGL2, no RT hardware: rays are traced in
// fragment shaders against one BVH of the ship's static geometry, in ship space).
//
// Why it is affordable: the interior, cockpit shell and hull are static in ship-local space. The ship turns and
// the star moves, but the geometry does not, so the BVH is built once (setStaticScene) and only the camera, the
// sun direction and the lamps change per frame. Lamp light stays baked; only the sun is traced.
//
// ---------------------------------------------------------------------------------------------- integration
//
// Loader (once per interior build, behind the progress bar):
//   const rt = createRayTracer(pipeline.renderer, { quality: rt.recommendedTier() /* or 'low' */ });
//   await rt.setStaticScene(meshes, toShip, { exterior: [hullObject] });   // compiles its programs too
//     meshes  = the OPAQUE static meshes: interior mesh (not 'interior-glass'), cockpit shell/console meshes,
//               and the player's hull channel 0 mesh (wings/nose shadow the windows). Transparent, additive
//               and depthWrite:false materials are skipped automatically; userData.rt = { skip: true } skips a
//               mesh, userData.rt = { role: 'exterior' } (or opts.exterior) marks hull meshes.
//     toShip  = inverse of the interior root's matrixWorld at that moment (identity when they are built at the
//               origin, as interior.ts / cockpit.ts / ships.ts do). Positions become toShip × matrixWorld × v.
//     Moving parts (stick, levers, screens) must not be passed: the BVH never changes after the build.
//
// scene.ts, per frame while inside (after interior.update / InteriorLighting.update, before the interior pass):
//   rt.render({ camera: insideCam, shipMatrixWorld: interior.object3d.matrixWorld,
//               sun: { dirShip: <c.sunDir, ship-local>, color: keyColor, intensity: key.intensity,
//                      angularRadius: Math.asin(starRadius / starDistance) },
//               envMap: <cube of the outside, world axes> , lamps: cabinLights ? 1 : 0, bakedGain: 2^-EV,
//               time, frame, width, height /* size of the interior HDR target */ });
//   if (rt.active) the interior's forward materials must NOT receive the sun:
//     - the shadow-mapped sun DirectionalLight: exclude interior + cockpit meshes from it (layers, or intensity 0
//       for the inside pass); the current interior.ts shader: pass sunColor = 0 in InteriorUpdate;
//     - reflection probes / envMap specular on interior materials with roughness < 0.5: set envMapIntensity 0
//       when the 'reflections' effect is on (rays + env fallback replace them; rough surfaces keep the probes);
//     - nothing else changes: baked lamp lightmaps (uv1), emissives, planetshine through the windows, the
//       hull outside, glass, effects all stay in the forward pass.
//   Then draw the interior pass into the HDR target as now, and before bloom / exposure metering:
//   pipeline.ts: rt.composite(hdrTarget.texture, hdrTarget)  — IN PLACE, with the interior pass's depth still in
//     hdrTarget (it uses LEQUAL + polygon offset against it). With MSAA this is the multisampled target before
//     resolve; if that is not possible, pass a different target and it copies hdrColor first (dynamic objects
//     such as levers then get the sun of the static surface behind them).
//   It adds, linear HDR, three.js light units: sun direct (Lambert + GGX × N·L × traced disc visibility), sun
//   bounce (albedo × mean incoming sun-bounce radiance) and glossy reflections (× split-sum env BRDF), and
//   multiplies the existing colour by near-field AO at 'ultra'.
//
// Perf overlay: rt.stats() (rays, bvhNodes, triangles, buildMs, msGpuEstimate, bytes, tier) — measure real GPU
// time with EXT_disjoint_timer_query_webgl2 where it exists (iOS does not expose it: use frame-time deltas
// with RT on/off) and drop the tier when the budget is exceeded.
export { createRayTracer, RT_TIERS, type RayTracer, type RtEffects, type RtFrame, type RtQuality, type RtStats, type RtSun } from './tracer';
export { mergeStatic, buildPacked, trace, traceBrute, measureWork, type MergeOptions, type MergedScene, type VertexSurface, type SurfaceReader } from './bvh';
