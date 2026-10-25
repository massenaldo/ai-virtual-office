# Milestone 2 — Realistic Office Builder: Tasks

**Spec:** [`plan.md`](plan.md) (Milestone 2 brief). This file is my working task list for that spec.
**Status:** Draft. Implementation starts after the open questions at the end are answered.

## What this milestone is

A visual upgrade of the existing 3D office, not a rewrite. The office should look like a real, premium modern tech office: warm wood desks, graphite metal, glass partitions, realistic chairs and monitors, natural daylight. The dark app UI, the layout editor, saving, undo/redo and `/vo` must all keep working. The scope is visual realism only: no AI agents, backend, auth, multiplayer or video studio.

## Current state (from inspecting the code, 2026-10-25)

- **Build and tests:** `npm run build` passes (only a chunk-size warning, already present before this milestone). `npm test` passes, 84/84.
- **Scene code:** `src/scene/`
  - `OfficeScene.tsx`: lights, floor, cameras
  - `RoomMesh.tsx`: room floor slab, 2 side walls, glass back wall, ceiling slab, label
  - `FurnitureItem.tsx` and `models.tsx`: 5 procedural models built from primitives
  - `FootprintOutline.tsx`, `ResizeHandles.tsx`, `useFloorDrag.ts`: editor feedback and interaction
- **Layout data:** `src/layout/`. The scene renders `OfficeLayout` (schema v1, key `ai-virtual-office:layout:v1`). Furniture types are desk, chair, monitor, plant and meeting-table, and storage only accepts known types.
- **Remote asset:** `<Environment preset="apartment">` downloads `lebombo_1k.hdr` from `raw.githack.com` at runtime. This conflicts with plan.md §7 (self-hosted).
- **Shadows:** every model mesh and every wall casts shadows (13 `castShadow` uses), with a 2048² shadow map.
- **Visibility:** each room has a solid ceiling slab plus three walls with an open front side, so the ceiling hides the room interior from above.
- **Floor plan:** an orthographic top-down camera with furniture drawn as flat coloured tiles. Walls and ceilings are hidden.

## How I'll work

- **One stage = one branch = one PR into `main`**, e.g. `feat/office-visuals-stage-a`. No stacked PRs. You merge, then I delete the merged branches.
- **Before/after screenshots from the same fixed camera angles** go in every PR (3D overview, a close-up, floor plan), because visual quality can't be checked by unit tests.
- **Each stage ends with the editor regression checklist below,** run in the browser, plus `npm test` and `npm run build`.
- **Decisions follow your direction over plan.md §10.** plan.md says "do not stop after producing a plan", but you asked to discuss first and review each stage, so I'll stop for review after each PR.

## Proposed decisions (mine, not yet agreed)

1. **Lighting without downloads:** replace the remote HDR with lighting built in code (drei `Environment` with `Lightformer` panels, plus sun and soft fill lights). No network requests and no new dependency.
2. **No new rendering dependencies:** no post-processing library. Soft shadows come from tuned shadow maps plus the existing `ContactShadows`, and "ambient occlusion" is faked cheaply (darker contact areas, baked gradients) rather than a real-time AO pass.
3. **Floor material comes from the room's department** (for example carpet for offices, concrete for the server room), so the saved-layout format doesn't change.
4. **New furniture types extend the schema in a backward-compatible way.** Storage cabinet, shelf and meeting chair are added to the furniture list. Old saves still load and the schema stays v1. Keyboard, mouse and desk accessories become part of the desk model, not separate items.
5. **Shared geometry and materials:** one shared materials module, and each furniture model's parts are merged into a few meshes (using three.js's own utilities, nothing new to install). Only larger objects cast shadows; small details don't.
6. **Changing the default office only affects Reset.** Your saved layout keeps its own rooms and furniture; new furniture only appears in the default after Reset layout.

## Stage A: Lighting, materials, floor, walls, structure

- [ ] Lighting built in code instead of the remote HDR; balanced daylight plus soft interior fill; tuned tone mapping and exposure
- [ ] Shared material library (oak/walnut, graphite metal, warm-white and warm-grey wall paint, glass, concrete, carpet)
- [ ] Office floor finish plus per-room floors (by department), with clear room boundaries
- [ ] Walls with real thickness, clean corners and baseboards; ceiling handling per **Q1**
- [ ] Clean background and a default overview camera that shows the whole office
- [ ] Floor plan stays clear: readable room colours, boundaries and labels
- [ ] PR with before/after screenshots

## Stage B: Furniture models

- [ ] Desk: proper top thickness, graphite frame, optional drawer unit or cable tray, keyboard and mouse
- [ ] Monitor: slim dark bezel, screen surface, stand and base
- [ ] Ergonomic chair: seat, backrest, armrests, gas lift, 5-star base with wheels; low polygon count
- [ ] Meeting table refresh, plus **new** meeting chair, storage cabinet and shelf (schema, palette, catalog footprints, floor-plan tiles, tests)
- [ ] Footprints in `catalog.ts` match the new models, so selection, overlap checks and snapping stay accurate
- [ ] PR with before/after screenshots

## Stage C: Glass, doors, plants, details

- [ ] Glass partitions with slim graphite frames for meeting rooms and offices; walls and glass never catch clicks
- [ ] Doors where they make sense, per **Q1**
- [ ] Plants with leaf clusters in a proper planter, in a couple of sizes
- [ ] A few restrained details (wall art, a whiteboard in meeting rooms) that never block editing
- [ ] Default office updated with the new furniture (meeting chairs, storage)
- [ ] PR with before/after screenshots

## Stage D: Optimize and verify

- [ ] Count draw calls and meshes before and after; limit shadow casters; check frame rate while dragging
- [ ] Full editor regression checklist in 3D and floor plan
- [ ] Production build (`vite preview`) checked in the browser; `/vo` end to end
- [ ] README updated (visuals, assets and licences if any, limitations)
- [ ] Final report per plan.md §10

## Editor regression checklist (every stage)

- Select, move, resize and rename rooms
- Select, move, rotate, duplicate, add and delete furniture
- Undo and redo
- Save → reload restores the layout
- Reset layout, with its confirmation
- 3D and floor plan stay in sync
- Grid and snap
- Keyboard shortcuts
- Selection outlines and labels stay readable over the new materials
- No console errors

## Open questions (need your answer before Stage A)

- **Q1: Ceilings and front walls.** Should the 3D overview be a cutaway (no ceilings, so you see into every room from above)? Should rooms get a front wall with a door, or keep the open front?
- **Q2: Reference look.** Is there an image, a real office or a product you want it to resemble?
- **Q3:** Are the proposed decisions 1–6 above OK?
