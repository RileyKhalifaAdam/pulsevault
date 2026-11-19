# Texture credits

The photo detail pack (`src/render/space/photo/pack.generated.ts`) is built by `node tools/fetch-textures.mjs`
from CC0 libraries only. CC0 needs no attribution; it is recorded here anyway, with what was changed.

Licence check: the script refuses any asset whose API record carries a licence field that is not CC0. Neither the
Poly Haven API (`/info`, `/files`) nor the ambientCG API (v2 `full_json`, v3 `assets`) exposes a per-asset
licence field (checked 2026-11-19), so the licence recorded is the library-wide one: every Poly Haven asset is
CC0 1.0 (polyhaven.com/license) and every ambientCG asset is CC0 1.0 (docs.ambientcg.com/license). Those licence
pages were not reachable from the build machine's network and were not re-read; the statement is the libraries'
published policy.

Generated pack: 3.17 MB of page bytes (base64), 55.67 MB of GPU memory with mipmaps at 'high'
(1/4 of that at 'medium', 1/16 at 'low').

| id | asset | author | capture | licence | tile (m) | maps (colour/normal/ORM) | page | GPU | use | changes |
|---|---|---|---|---|---|---|---|---|---|---|
| whitePanel | [Plastic 013 B](https://ambientcg.com/a/Plastic013B) (`Plastic013B`) | ambientCG (Lennart Demes) | procedural (Substance), not a scan | CC0 1.0 (ambientCG library licence; the API carries no per-asset licence field, none found) | 1 x 1 | 1024/512/512 | 191 KiB | 8.00 MB | work areas: white painted composite wall and ceiling panels, consoles | resized, v-flipped, JPEG; colour re-tinted to linear mean 0.62/0.62/0.6 |
| gunmetal | [Metal 063](https://ambientcg.com/a/Metal063) (`Metal063`) | ambientCG (Lennart Demes) | photo-based (approximated PBR) | CC0 1.0 (ambientCG library licence; the API carries no per-asset licence field, none found) | 1 x 1 | 512/512/256 | 81 KiB | 3.00 MB | work areas: dark gunmetal frames, rails, machinery; exterior: scratched dark metal | resized, v-flipped, JPEG; none |
| tread | [Rubber 004](https://ambientcg.com/a/Rubber004) (`Rubber004`) | ambientCG (Lennart Demes) | procedural (Substance), not a scan | CC0 1.0 (ambientCG library licence; the API carries no per-asset licence field, none found) | 0.75 x 0.75 | 512/512/256 | 288 KiB | 3.00 MB | work areas: rubber tread deck | resized, v-flipped, JPEG; colour re-tinted to linear mean 0.04/0.04/0.045 |
| grating | [Metal Walkway 006](https://ambientcg.com/a/MetalWalkway006) (`MetalWalkway006`) | ambientCG (Lennart Demes) | procedural (Substance), not a scan | CC0 1.0 (ambientCG library licence; the API carries no per-asset licence field, none found) | 0.8 x 0.8 | 512/512/256+a512 | 378 KiB | 4.33 MB | work areas: metal floor grating, catwalks (alpha test) | resized, v-flipped, JPEG; none |
| netting | [Net 004 A](https://ambientcg.com/a/Net004A) (`Net004A`) | ambientCG (Lennart Demes) | procedural (Substance), not a scan | CC0 1.0 (ambientCG library licence; the API carries no per-asset licence field, none found) | 1.1 x 1.1 | 512/512/256+a512 | 309 KiB | 4.33 MB | work areas: cargo netting and webbing (alpha test) | resized, v-flipped, JPEG; colour re-tinted to linear mean 0.05/0.05/0.045 |
| leather | [Brown Leather](https://polyhaven.com/a/brown_leather) (`brown_leather`) | Rob Tuytel | photo-scanned (Poly Haven scan) | CC0 1.0 (Poly Haven library licence; the API carries no per-asset licence field, none found) | 0.4 x 0.4 | 1024/512/512 | 762 KiB | 8.00 MB | living areas: worn red leather seats and sofa (vintage brown scan re-tinted to oxblood) | resized, v-flipped, JPEG; colour re-tinted to linear mean 0.12/0.022/0.018 |
| brushed | [Metal 009](https://ambientcg.com/a/Metal009) (`Metal009`) | ambientCG (Lennart Demes) | procedural (Substance), not a scan | CC0 1.0 (ambientCG library licence; the API carries no per-asset licence field, none found) | 1 x 1 | 512/512/256 | 78 KiB | 3.00 MB | living areas: brushed metal trims, galley fronts, fittings | resized, v-flipped, JPEG; colour re-tinted to linear mean 0.55/0.56/0.58 |
| veneer | [Smoked Walnut Veneer](https://polyhaven.com/a/smoked_walnut_veneer) (`smoked_walnut_veneer`) | Jenelle van Heerden | photo-scanned (Poly Haven scan) | CC0 1.0 (Poly Haven library licence; the API carries no per-asset licence field, none found) | 1 x 1 | 1024/512/512 | 197 KiB | 8.00 MB | living areas: dark wood veneer (raw scan darkened to an oiled finish) | resized, v-flipped, JPEG; colour re-tinted to linear mean 0.09/0.05/0.03 |
| fabric | [Poly Wool Herringbone](https://polyhaven.com/a/poly_wool_herringbone) (`poly_wool_herringbone`) | colormass, Rico Cilliers | photo-scanned (Poly Haven scan) | CC0 1.0 (Poly Haven library licence; the API carries no per-asset licence field, none found) | 0.27 x 0.276 | 1024/512/512 | 654 KiB | 8.00 MB | living areas: upholstery fabric, bunks, padded panels (neutral grey: tint with vertex colour) | resized, v-flipped, JPEG; none |
| hullPaint | [Painted Metal 012](https://ambientcg.com/a/PaintedMetal012) (`PaintedMetal012`) | ambientCG (Lennart Demes) | procedural (Substance), not a scan | CC0 1.0 (ambientCG library licence; the API carries no per-asset licence field, none found) | 2.5 x 2.5 | 512/512/256 | 203 KiB | 3.00 MB | exterior: worn white paint over metal | resized, v-flipped, JPEG; orange corrosion desaturated to bare metal |
| nozzle | [Metal 038](https://ambientcg.com/a/Metal038) (`Metal038`) | ambientCG (Lennart Demes) | procedural (Substance), not a scan | CC0 1.0 (ambientCG library licence; the API carries no per-asset licence field, none found) | 0.8 x 0.8 | 512/512/256 | 103 KiB | 3.00 MB | exterior: heat-tinted metal for nozzles and exhaust parts (bands run along v) | resized, v-flipped, JPEG; thin-film heat tint baked into the colour, luminance set to 0.3 |

Downloaded files (cached under `shots/textures-src/`, git-ignored, never committed):

- whitePanel: https://ambientcg.com/get?file=Plastic013B_2K-JPG.zip
- gunmetal: https://ambientcg.com/get?file=Metal063_1K-JPG.zip
- tread: https://ambientcg.com/get?file=Rubber004_1K-JPG.zip
- grating: https://ambientcg.com/get?file=MetalWalkway006_1K-JPG.zip
- netting: https://ambientcg.com/get?file=Net004A_1K-JPG.zip
- leather: https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/brown_leather/brown_leather_albedo_2k.jpg , https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/brown_leather/brown_leather_nor_gl_1k.jpg , https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/brown_leather/brown_leather_ao_1k.jpg , https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/brown_leather/brown_leather_rough_1k.jpg
- brushed: https://ambientcg.com/get?file=Metal009_1K-JPG.zip
- veneer: https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/smoked_walnut_veneer/smoked_walnut_veneer_diff_2k.jpg , https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/smoked_walnut_veneer/smoked_walnut_veneer_nor_gl_1k.jpg , https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/smoked_walnut_veneer/smoked_walnut_veneer_ao_1k.jpg , https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/smoked_walnut_veneer/smoked_walnut_veneer_rough_1k.jpg
- fabric: https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/poly_wool_herringbone/poly_wool_herringbone_diff_2k.jpg , https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/poly_wool_herringbone/poly_wool_herringbone_nor_gl_1k.jpg , https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/poly_wool_herringbone/poly_wool_herringbone_ao_1k.jpg , https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/poly_wool_herringbone/poly_wool_herringbone_rough_1k.jpg , https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/poly_wool_herringbone/poly_wool_herringbone_metal_1k.jpg
- hullPaint: https://ambientcg.com/get?file=PaintedMetal012_1K-JPG.zip
- nozzle: https://ambientcg.com/get?file=Metal038_1K-JPG.zip
