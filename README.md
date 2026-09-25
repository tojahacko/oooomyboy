# House 360

360° turntable videos of houses rebuilt as volumetric 3D models from their
reference images. The model stays fixed and only the camera moves: one
continuous orbit at constant radius, height and focal length. Angle 0° is the
front, 90° the east/right side, 180° the rear and 270° the west/left side.

| house | video | references | model |
|-------|-------|------------|-------|
| *Dom w zielistkach 34 (A)* | [`output/zielistki34_360.mp4`](output/zielistki34_360.mp4) | `source/zielistki34/` (the six DOCX images) | `src/houses/zielistki34.js` |
| *Dom w macierzankach 5 (G2)* | [`output/macierzanki5_360.mp4`](output/macierzanki5_360.mp4) | `source/macierzanki5/` | `src/houses/macierzanki5.js` |

Both videos are 1920×1080, 60 fps, 16 s and loop seamlessly. Each
`output/<house>_stills/` folder holds 16 frames, one every 22.5°.

## Dom w zielistkach 34 (A)

Reconstructed from all six DOCX images: the front, garden, east and west
elevations, plus the two perspective renders. The perspective views settle
the pergola layout, the entrance landing and the canopy.

- **Walls:** a 10.5 × 8.3 m single volume with 0.35 m walls. The ground
  floor is white plaster and the upper floor light grey, with a flashing line
  between them and a plinth at the base.
- **Roof:** a 42.7° gable roof built as slabs with real thickness, plus
  0.9 m boxed eaves (soffit, fascia and half-round gutters) and 0.67 m verges
  with purlin ends.
- **Roof details:** a ridge cap, two chimneys (one on each slope, placed from
  all four elevations) and the roof window on the garden slope.
- **Openings:** every window and door is cut through the wall, with the frame
  12 cm back from the face. The frames are anthracite, with mullions, sills
  and part-lowered blinds behind the glass.
- **Upper floor:** three French windows with frameless glass balustrades.
- **Garden side:** a two-panel lift-and-slide door.
- **Timber:** board cladding around the front door, across the eastern
  garden façade, and in a vertical strip on the west gable.
- **Entrance:** a glass canopy on steel arms with tension rods, the "V" house
  number, an intercom, a door with a glass strip and bar handle, and a
  concrete landing with a step.
- **Pergola:** a timber pergola over the raised deck, with four corner posts,
  a middle front post, a wall ledger and 13 rafters. The deck has a step.
- **Downspouts:** at the two west corners, routed under the soffit.

## Usage

```sh
npm install
node tools/render.mjs --house zielistki34 --ss 2               # -> output/zielistki34_360.mp4 (needs playwright + ffmpeg)
node tools/render.mjs --house zielistki34 --stills --count 16  # stills every 22.5°
npm run serve                                                  # viewer: http://localhost:8080/?house=zielistki34 (drag to rotate)
```

Render options: `--house <name> --seconds 16 --fps 60 --w 1920 --h 1080 --ss 2 --out path.mp4`.
`--ss` renders at a multiple of the size and downsamples, which removes
shimmer on fine detail.

The shared geometry and texture helpers are in `src/lib.js`. The scene,
lighting and orbit are in `src/scene.js`.

## Walkthrough: Dom w zielistkach 34 (A)

[`output/zielistki34_walkthrough.mp4`](output/zielistki34_walkthrough.mp4) is a one-take,
first-person walkthrough at eye level. It starts in the garden, steps onto the
terrace, enters through the open terrace sliding door, and walks through the
living room and dining area into the kitchen. It was path-traced in Blender
Cycles, at 1280×720, 24 fps, 52 s.

The ground-floor day zone is reconstructed from the ten interior photos
(`source/zielistki34/interior_*.png`), placed inside the exterior model and
cross-checked against landmarks that appear in several photos:

- the terrace door, dining window and kitchen window line up with the elevations
- the corner fireplace sits around the chimney flue
- the TV wall and the corridor doors
- the feature wall with the L-shaped sofa and two artworks
- the dining table with six chairs and the linear pendant
- the U-shaped kitchen with its oak-fronted peninsula, oak tall units with the
  oven and coffee machine, white handleless cabinets and back-painted glass
- the wooden venetian blinds

Nothing else is added. The hall, the rooms behind the corridor doors and the
upper floor aren't shown in the photos, so the walk never enters them.

Pipeline (`walkthrough/`):

```sh
node tools/export_obj.mjs --out house.obj                     # exterior shell from the three.js model
python3 walkthrough/build_scene.py house.obj walk.blend       # interior, garden, vegetation, sky (needs `pip install bpy`)
python3 walkthrough/walk.py --check                           # path clearance, speed and turn-rate report
python3 walkthrough/walk.py walk.blend frames/ --samples 12   # render frames (resumable)
python3 walkthrough/preview.py walk.blend previews/           # stills matching the reference photos
```

What each file does:

- `materials.py` holds the procedural materials.
- `vegetation.py` builds trees, hedges and the lawn as real meshes: birches
  with leaves on a twig network, pines, thujas, and 0.5 m grass tiles.
- `walk.py` defines the camera path: spline keys, eased start and finish,
  auto-exposure across the threshold, 180° shutter motion blur.

The reference images are © ARCHON+ (archon.pl).
