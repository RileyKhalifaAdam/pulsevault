// Hybrid ray-traced sunlight for the ship interior (iPhone 15 / WebGL2, no RT hardware: rays are traced in
// fragment shaders against one BVH of the ship's static geometry, in ship space).
//
// Why it is affordable: the interior, cockpit shell and hull are static in ship-local space. The ship turns and
// the star moves, but the geometry does not, so the BVH is built once (setStaticScene) and only the camera, the
// sun direction and the lamps change per frame. Lamp light stays baked; only the sun is traced.
//
// ---------------------------------------------------------------------------------------------- integration
// (as wired in src/render/scene.ts)
//
// Loader (behind the progress bar, once per interior build, after its lightmaps are decoded):
//   const rt = createRayTracer(renderer, { quality });
//   rt.patchMaterials(interiorRoot)  // BEFORE the interior's materials compile (InteriorLighting.warmUp)
//   await rt.setStaticScene(meshes, toShip, { exterior: [hullLod1Mesh], rasterKey: roomOfMesh });  // + its programs
//     meshes  = the static opaque meshes of the interior and the cockpit (not the moving controls: their position
//               attribute is DynamicDrawUsage; not instanced meshes; not glass), plus the hull's cheapest LOD
//               marked exterior (front faces only: wings, nose and pods shadow the windows; never rasterised).
//     Material data per vertex comes from mesh.userData.rt (surfaces.ts header: per-tile albedo / roughness /
//     metalness, cockpit colour+pbr, hull tint x livery), else the three.js material.
//     rasterKey: the room of a mesh — the G-buffer draws only the rooms the forward pass draws (frame.rooms).
//
// Per frame while inside, before the pipeline renders:
//   if (rt.willRun) the interior sun light gets intensity 0 (so InteriorLighting renders no sun shadow map);
//   rt.render({ camera, shipMatrixWorld, sun: { dirShip, color, intensity, angularRadius }, envMap: <raw outside
//              cube, world axes>, lamps, bakedGain: 2^-EV, rooms: <visible room ids>, width/height of the HDR target });
//   otherwise rt.skip().
//   The patched materials (forward.ts) then take the traced light in their own forward pass: the sun as an extra
//   RE_Direct light × traced visibility, the sun bounce as irradiance, and traced reflections replacing the probe
//   radiance below roughness ~0.32 — multiplied by each pixel's own albedo, normal and roughness (photo scans,
//   normal maps and lightmaps show in the sun: the "demodulated" fix of the first composite).
//   composite() (adding light onto a finished image with per-vertex albedo) is kept for experiments only.
//
// Perf overlay: rt.stats() (rays, bvhNodes, triangles, buildMs, msGpuEstimate, msGpu — measured with
// EXT_disjoint_timer_query_webgl2 where it exists, -1 on iOS — bytes, drawCalls, tier); rt.bytesAt(tier, w, h).
export { createRayTracer, RT_TIERS, type RayTracer, type RtEffects, type RtFrame, type RtQuality, type RtStats, type RtSun } from './tracer';
export { createForwardUniforms, patchMaterialForRt, patchTreeForRt, RT_FORWARD_KEY, type RtForwardUniforms } from './forward';
export { mergeStatic, buildPacked, trace, traceBrute, measureWork, type MergeOptions, type MergedScene, type VertexSurface, type SurfaceReader, type RtRecord, type RasterIndex } from './bvh';
