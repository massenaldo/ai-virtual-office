# Office Visuals — Stage B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the toy-like furniture with realistic, low-poly procedural models (desk, ergonomic chair, monitor, meeting table) and add three new furniture types (meeting chair, storage cabinet, shelf) that work everywhere in the editor.

**Architecture:**
- **Models:** a pure, tested `furnitureModels.ts` builds each furniture type once. The parts are merged into **one geometry per material** (three's own `mergeGeometries`, nothing new to install) and cached, so every desk shares the same few meshes.
- **Rendering:** `FurnitureItem` renders those parts with shared materials.
- **Footprints:** `catalog.ts` footprints are updated so each model's real size equals its footprint; selection outlines, overlap checks and snapping stay accurate.
- **Unchanged:** the schema stays v1. New types only extend the type list, so old saves still load.

**Tech Stack:** React 19, three 0.174 (`three/examples/jsm/utils/BufferGeometryUtils.js`), @react-three/fiber 9, Vitest. No new dependencies.

**Spec:** `plan.md` §4–§7 and `tasks.md` (Stage B list, decisions 4 and 5).

## Global Constraints

- **No new dependencies; no remote assets.** The `noRemoteAssets` guard must stay green.
- **Schema stays v1.** The new types are `'meeting-chair' | 'storage-cabinet' | 'shelf'`. Old saved layouts must still load unchanged (decision 4).
- **Keyboard, mouse and desk accessories are part of the desk model**, not separate items (decision 4).
- **At most 4 meshes per furniture model** (one per material), cached and shared (plan.md §4, decision 5). Only large parts cast shadows.
- **Facing convention (unchanged):** at rotation 0 the user faces −Z. Monitor screens face +Z, and chair backrests sit at +Z.
- **Realistic dimensions (metres):**
  - desk top 0.75 high
  - chair seat ≈ 0.47, back top ≈ 1.05
  - monitor base sits on the desk top (0.75), screen ≈ 0.55 × 0.33
  - meeting table 0.74
  - cabinet ≈ 1.1 high
  - shelf ≈ 1.8 high
- **Plants are unchanged in Stage B** (Stage C). The default office is unchanged in Stage B (new furniture joins it in Stage C).
- **Editor behaviour is unchanged.** The `tasks.md` regression checklist must pass.
- One PR to `main` from `feat/office-visuals-stage-b`, with before/after screenshots.

## Review Focus

1. **Old saved layouts** (only the original 5 types) must load and render unchanged. Pinned in Task 1 (storage round trip with old and new types).
2. **Default layout with the new footprints** must still report zero overlap issues (chair base grows to 0.62 m). Pinned by the existing `findIssues(default)` test, re-run in Task 1.
3. **Every model fits its footprint** in all four rotations, so outlines and overlap checks match what you see. Pinned in Task 3 (bounding box ⊆ footprint and ≥ 75% of it).
4. **Selecting small or detailed furniture** (monitor, keyboard area, chair wheels) in 3D must still work: clicks on any part select the item. Verified in Task 5 (meshes keep the group's handlers).
5. **New types added from the palette** can be moved, rotated, duplicated, deleted, saved and reloaded. Verified in Task 5.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/layout/types.ts` | `FurnitureType` gains `'meeting-chair' \| 'storage-cabinet' \| 'shelf'` |
| `src/layout/catalog.ts` | Footprints and labels for all 8 types (updated sizes) |
| `src/layout/validation.ts` | Meeting chairs may tuck under meeting tables |
| `src/scene/materials.ts` (+ test) | Furniture materials: oakVeneer, walnut, fabric, plastic, screen, chrome, cabinetWhite |
| `src/scene/furnitureModels.ts` (+ test) | `modelParts(type)`: cached merged geometries per material |
| `src/scene/FurnitureItem.tsx` | Renders `modelParts`; plan tiles for the new types |
| `src/scene/models.tsx` | Deleted (replaced by `furnitureModels.ts`) |

---

### Task 1: New furniture types and realistic footprints

**Files:**
- Modify: `src/layout/types.ts`, `src/layout/catalog.ts`, `src/layout/validation.ts`
- Test: `src/layout/storage.test.ts`, `src/layout/validation.test.ts`, `src/layout/operations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FurnitureType = 'desk' | 'chair' | 'monitor' | 'plant' | 'meeting-table' | 'meeting-chair' | 'storage-cabinet' | 'shelf'
  ```
- `FURNITURE_SPECS` (width × depth, `planColor`; cabinet colour later changed to `#9c968c` for floor-plan contrast):
  - desk 1.4 × 0.72 `#c49a6c`
  - chair 0.62 × 0.62 `#3b3f45`
  - monitor 0.56 × 0.22 `#1c1e21`
  - plant 0.56 × 0.56 `#53775d` (unchanged)
  - meeting-table 2.7 × 1.15 `#6b4a33`
  - meeting-chair 0.56 × 0.56 `#5a5e66`
  - storage-cabinet 0.8 × 0.45 `#d9d6d0`
  - shelf 0.9 × 0.35 `#8b6a4f`
  - Labels: "Desk", "Office chair", "Monitor", "Plant", "Meeting table", "Meeting chair", "Storage cabinet", "Shelf"
- Validation: `mayShareSpace` also allows `meeting-chair` with `meeting-table` (either order).
- Ruling to carry: desk width 1.35 → 1.4 is safe. The backend desks sit 1.4 m apart, so the edges touch, and touching doesn't count as overlap (epsilon 0.01).

- [ ] **Step 1: Write failing tests:**
  - storage: a layout containing a `shelf` and a `meeting-chair` round-trips through `saveLayout`/`loadLayout` with `problem: null`
  - storage: a stored layout with only the original 5 types still loads with `problem: null`
  - validation: a `meeting-chair` at the centre of a `meeting-table` produces no issue, while two `storage-cabinet`s on one spot produce `furniture-overlap`
  - operations: `addFurniture(l, 'storage-cabinet', { x: -7, z: -4 })` lands in `room-ceo-office`
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (type errors / unknown types rejected).
- [ ] **Step 3: Implement** the union, the specs above, and the sharing rule.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS, including the existing `findIssues(createDefaultLayout()).size === 0`. If that fails, the footprints above are wrong; fix the specs, not the rule.
- [ ] **Step 5: Commit** `feat(layout): add meeting chair, storage cabinet and shelf types`.

### Task 2: Furniture materials

**Files:**
- Modify: `src/scene/materials.ts`
- Test: `src/scene/materials.test.ts`

**Interfaces:**
- Produces: `SharedMaterials` gains these keys, all `MeshStandardMaterial`, created once:
  - `oakVeneer` `#c49a6c` r 0.5
  - `walnut` `#6b4a33` r 0.45
  - `fabric` `#3b3f45` r 0.95
  - `plastic` `#1c1e21` r 0.5
  - `screen` `#0f1720` r 0.2, emissive `#24485a`, emissiveIntensity 0.55
  - `chrome` `#b9bdc2` metalness 0.85, r 0.25
  - `cabinetWhite` `#ecebe7` r 0.6
- Plus `export type MaterialKey = keyof SharedMaterials`.

- [ ] **Step 1: Failing test:** `sharedMaterials().screen.emissiveIntensity > 0`; `sharedMaterials().walnut !== sharedMaterials().oakVeneer`; every key in `['oakVeneer','walnut','fabric','plastic','screen','chrome','cabinetWhite']` is defined.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scene): add shared furniture materials`.

### Task 3: Procedural furniture models

**Files:**
- Create: `src/scene/furnitureModels.ts`
- Test: `src/scene/furnitureModels.test.ts`

**Interfaces:**
- Consumes: `FURNITURE_SPECS` (Task 1), `MaterialKey` (Task 2).
- Produces:
  ```ts
  export type ModelPart = { material: MaterialKey; geometry: THREE.BufferGeometry; castShadow: boolean }
  export function modelParts(type: FurnitureType): ModelPart[] // built once per type and cached
  ```
- Build each part with small helpers (`box(w, h, d, x, y, z)`, `cylinder(rTop, rBottom, h, segments, x, y, z)`, rotated cylinders for the wheels), group them by material, and merge each group with `mergeGeometries`. The origin is the footprint centre on the floor.
- Models:
  - **desk:** oakVeneer top 1.4 × 0.03 × 0.72 at y 0.735
  - **desk frame (graphite):** two T-legs, a crossbar and a cable tray under the back edge
  - **desk accessories (plastic):** keyboard 0.44 × 0.02 × 0.14 and mouse 0.06 × 0.02 × 0.1, at local z +0.12 (the user's side)
  - **chair:** fabric seat and backrest with a slight backward tilt; plastic armrests; chrome gas lift; plastic 5-star base whose 5 wheels reach radius 0.31
  - **monitor:**
    - plastic stand: base 0.22 × 0.015 × 0.18 at y 0.75, neck up to 0.98
    - plastic bezel: 0.56 × 0.34 × 0.025 centred at y 1.09, z −0.03
    - screen: 0.54 × 0.32 plane on the +Z face
  - **meeting-table:** walnut top 2.7 × 0.04 × 1.15 at y 0.72, with two graphite pedestal bases
  - **meeting-chair:** a lighter chair with fabric seat and back on 4 graphite legs, seat 0.46
  - **storage-cabinet:** cabinetWhite body 0.8 × 1.1 × 0.45, oakVeneer top, plastic handle lines
  - **shelf:** walnut frame 0.9 × 1.8 × 0.35 with 4 shelves; plastic books on two shelves
  - **plant:** the current pot and two foliage spheres, ported unchanged (Stage C upgrades it)
- Shadows: `castShadow` true for desk top and frame, chair, meeting table, cabinet, shelf and plant; false for monitor and accessory parts.

- [ ] **Step 1: Write failing tests**, for every type in `FURNITURE_SPECS`:
  - `modelParts(t).length <= 4`
  - materials are unique within a model
  - `modelParts(t) === modelParts(t)` (cached)
  - the merged bounding box satisfies `minY >= -1e-6`, `|x| <= width/2 + 0.01`, `|z| <= depth/2 + 0.01`
  - the box spans at least 75% of the footprint on both axes
  - heights: desk `maxY` within [0.74, 0.79]; chair `maxY` within [1.0, 1.12]; monitor `minY` within [0.749, 0.751] and `maxY` within [1.2, 1.3]; meeting-table `maxY` within [0.73, 0.77]; storage-cabinet `maxY` within [1.08, 1.14]; shelf `maxY` within [1.78, 1.84]
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scene): realistic procedural furniture models`.

### Task 4: Render the new models

**Files:**
- Modify: `src/scene/FurnitureItem.tsx`
- Delete: `src/scene/models.tsx`

**Interfaces:**
- Consumes: `modelParts`, `sharedMaterials`.
- In 3D, the group renders `modelParts(item.type).map((p) => <mesh geometry={p.geometry} material={sharedMaterials()[p.material]} castShadow={p.castShadow} receiveShadow />)`. Pointer and drag handlers stay on the group, so every part is clickable.
- `PLAN_HEIGHT` gets entries for the 3 new types: meeting-chair 0.07, storage-cabinet 0.06, shelf 0.06. Floor-plan tiles use the updated `planColor`s.

- [ ] **Step 1: Implement**, and delete `models.tsx`.
- [ ] **Step 2: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 3: Browser check:** no console errors, all 54 default items render, and the palette shows 8 furniture types.
- [ ] **Step 4: Commit** `feat(scene): render realistic furniture models`.

### Task 5: Verify, screenshot and open the PR

- [ ] **Step 1: Baseline screenshots before Task 4** (on the Task 3 commit): overview, close-up crop (same region as Stage A), edit mode, floor plan.
- [ ] **Step 2: After screenshots** of the same views, plus a close-up of a desk group, the meeting table, and one each of the new types placed from the palette.
- [ ] **Step 3: Editor regression checklist** (`tasks.md`), including Review Focus 4–5: click the monitor, the keyboard area and a chair wheel, and each selects its item. Add, move, rotate, duplicate, delete, save and reload each new type.
- [ ] **Step 4: Frame-rate and mesh-count check.** Log `renderer.info.render.calls` before and after through a temporary debug hook (removed before commit). Expected: draw calls don't grow by more than ~25% over Stage A, despite the richer models.
- [ ] **Step 5:** Tick Stage B in `tasks.md`, convert screenshots to JPEG, and open PR `feat(scene): milestone 2 stage B — realistic furniture` into `main`.
