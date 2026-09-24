# House 360

A 360° orbit video of the bungalow *Dom w macierzankach 5 (G2)*. The house is
a volumetric 3D model reconstructed from its four elevation drawings.

**Result:** [`output/house_360.mp4`](output/house_360.mp4) (1920×1080, 60 fps, 16 s, seamless loop)

The camera orbits one fixed model at constant radius, height and focal length:

| angle | view | matches |
|------:|------|---------|
| 0° | front (south) | `source/elevation_front.png` |
| 90° | right (east) | `source/elevation_east.png` |
| 180° | rear (north) | `source/elevation_rear.png` |
| 270° | left (west) | `source/elevation_west.png` |

`output/stills/` holds 16 frames, one every 22.5°.

## The model

No image is mapped onto the house. Everything in `src/house.js` is geometry,
measured off the elevations (~55 px/m) and cross-checked between views:

- **Volumes:** T-shaped plan. The garage wing is 8.9 × 19.2 m and the main body
  7.0 × 9.0 m. Walls are 0.35 m thick.
- **Roof:** ~30° hip roofs with real valleys, ridge and hip caps, 0.84 m
  overhangs, soffits, fascia boards and half-round gutters.
- **Chimneys:** three, each placed from its position in all four elevations.
- **Openings:** every window and door is cut through the wall, so reveals are
  visible. Frames, mullions, glazing and sills are recessed 12 cm. This
  includes the corner window with its wrapped sill.
- **Doors:** the garage door has sectional panels. The entrance door and the
  side door have glass strips and bar handles.
- **Entrance:** a recessed corner porch with a white pillar, a beam, wood-lined
  walls and ceiling, a raised floor and a step.
- **Wood cladding:** individual vertical battens over a dark backing.
- **Trim and plinth:** a white upper band with a projecting trim line, and a
  plinth band.
- **Downspouts:** routed from the gutter outlets, under the soffit, down the
  walls, with wall brackets.
- **Terrace:** the garden deck shown in the rear and east elevations.

Materials are procedural: plaster, concrete-look render, wood, roof tiles.
The glazing reflects a sky and tree-line environment.

## Usage

```sh
npm install
node tools/render.mjs --ss 2                # -> output/house_360.mp4 (needs playwright + ffmpeg)
node tools/render.mjs --stills --count 16   # stills every 22.5° -> output/stills/
npm run serve                               # interactive viewer at http://localhost:8080 (drag to rotate)
```

Render options: `--seconds 16 --fps 60 --w 1920 --h 1080 --ss 2 --out path.mp4`
(`--ss` renders at a multiple of the size and downsamples, to remove shimmer
on fine detail).

The reference images in `source/` are © ARCHON+ (archon.pl).
