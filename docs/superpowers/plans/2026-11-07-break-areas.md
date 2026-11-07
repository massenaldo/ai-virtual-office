# Break Areas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The office gains a kitchen, a dining area and a prayer room with their furniture, in the default layout and in saved layouts where they fit, without ever moving anything a person placed.

**Architecture:** One pure module, `src/layout/breakAreas.ts`, owns the three rooms and all placement decisions. Layout schema 1 upgrades to 2 inside the existing `migrateLayout`, so the browser and the server behave the same. The upgrade happens on load and is written to disk only by the person's next save.

**Tech Stack:** TypeScript, React 19, three 0.174, @react-three/fiber 9, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-office-presence-daily-life-design.md`, section 6.5 "New places" and "Existing saved layouts". This is slice 4 of section 7.

## Global Constraints

- "A person's layout is never moved around automatically." Migration only ever adds, and adds all three rooms or none. Task 2 records the owner's compact set decision.
- `kitchen`, `dining` and `prayer` are room departments, excluded from the departments an agent can belong to, like `meeting`.
- 3D is built in code with no downloaded assets (`src/scene/noRemoteAssets.test.ts` stays in force).
- Prayer must never be shown disrespectfully: the mat is plain, with no symbols, text or decoration, and notice text is plain.
- Out of scope: schedule, presence, walking, characters using these rooms, prayer times, holding tasks. Nothing in this slice makes an agent leave its desk.
- Editing must not get worse.
- Conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Each task gets its own branch, stacked on the previous one: `feat/break-areas` (Task 1), `feat/break-areas-layout` (Task 2), `feat/break-areas-notice` (Task 3), `feat/break-areas-check` (Task 4). Every PR targets `main` and includes a screenshot, on mock data only because the repo is public.

## Review Focus

1. A saved layout with no space for all three rooms: it loads exactly as saved, with no rooms added, and the notice offers "Add break areas".
2. A schema 1 file on the server: the office shows the upgraded layout and "Saved", the file's bytes don't change until the person saves, and a restart gives the same result.
3. A person deletes the kitchen after upgrading: it never comes back on reload, and a dismissed notice stays dismissed in that browser.
4. An office floor too small for the new rooms, or an existing item already using a new ID: nothing throws, migration adds nothing, and "Add break areas" still produces a valid layout that passes `parseLayout`.
5. `department: 'kitchen'` on an agent, through the API or in a saved agent record: refused exactly as `meeting` is.

---

### Task 1: Departments, furniture and models

**Files:**
- Modify: `src/layout/types.ts`, `src/layout/catalog.ts`, `src/layout/validation.ts`, `src/layout/validation.test.ts`, `src/scene/furnitureModels.ts`, `src/scene/FurnitureItem.tsx`, `src/scene/materials.ts`, `src/scene/finishes.ts`, `src/scene/finishes.test.ts`, `src/workforce/types.ts`, `src/workforce/view.ts`, `src/workforce/operations.ts`, `src/workforce/operations.test.ts`, `src/workforce/storage.ts`, `src/workforce/storage.test.ts`

**Interfaces:**
- Produces: `DepartmentId` gains `'kitchen' | 'dining' | 'prayer'`; `FurnitureType` gains `'kitchen-counter' | 'coffee-machine' | 'dining-table' | 'dining-chair' | 'prayer-mat'`
- Produces in `catalog.ts`: `BREAK_DEPARTMENTS = ['kitchen', 'dining', 'prayer'] as const`, `type BreakDepartment`, and `isAgentDepartmentId(id: string): boolean`, which is the one rule for who can be an agent's department: it exists in `DEPARTMENTS`, and is not `meeting` or a break department
- Produces in `workforce/types.ts`: `AgentDepartment = Exclude<DepartmentId, 'meeting' | BreakDepartment>`

Values:

| Department | Label | Colour | Floor finish |
|---|---|---|---|
| `kitchen` | Kitchen | `#a9b4a0` | `epoxy` |
| `dining` | Dining | `#c2a27c` | `oak` |
| `prayer` | Prayer Room | `#9fb0a6` | `carpet` |

| Furniture | Label | Width × depth | Plan colour | Plan height | Model |
|---|---|---|---|---|---|
| `kitchen-counter` | Kitchen counter | 2.2 × 0.6 | `#b8b4ab` | 0.06 | `cabinetWhite` body 0.86 high, `oakVeneer` top |
| `coffee-machine` | Coffee machine | 0.34 × 0.3 | `#2b2e33` | 0.08 | `plastic` body and `chrome` details, standing on the 0.9 m counter top |
| `dining-table` | Dining table | 2.0 × 0.9 | `#c49a6c` | 0.06 | `oakVeneer` top, `graphite` legs |
| `dining-chair` | Dining chair | 0.46 × 0.46 | `#5a5e66` | 0.07 | `fabric` seat and back, `graphite` legs |
| `prayer-mat` | Prayer mat | 0.6 × 1.0 | `#6f7f5f` | 0.06 | New `prayerMat` material, colour `#6f7f5f`. A plain flat rectangle with a thin raised edge, one material, no symbols |

A prayer mat's model has its head end at −Z, like every other model's "faces −Z" rule. Add `prayer-mat` to `SHADOWLESS_TYPES`, since it's flat. Its top must sit above the room's floor surface: check the floor height in `src/scene/RoomMesh.tsx`.

- [ ] **Step 1: Write the failing tests**

```ts
// validation.test.ts
it('a coffee machine may stand on a counter, and dining chairs may tuck under a dining table', ...)
it('a coffee machine and a desk still warn when they overlap', ...)
// finishes.test.ts
it('break rooms use their floor finishes', ...)  // kitchen epoxy, dining oak, prayer carpet
// operations.test.ts (workforce), for each of kitchen, dining, prayer, meeting
it.each(['kitchen', 'dining', 'prayer', 'meeting'])('refuses %s as an agent department', ...)
// storage.test.ts (workforce)
it('an agent saved with a break department is invalid, as with meeting', ...)
```

Also add a test that `AGENT_DEPARTMENTS` contains none of the four.

- [ ] **Step 2: Run them to verify they fail**

Run: `rtk proxy npx vitest run src/layout/validation.test.ts src/scene/finishes.test.ts src/workforce/operations.test.ts src/workforce/storage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace the three separate `'meeting'` checks in `workforce/view.ts`, `workforce/operations.ts` and `workforce/storage.ts` with `isAgentDepartmentId`. Add `['coffee-machine', 'kitchen-counter']` and `['dining-chair', 'dining-table']` to the share list in `validation.ts`, and update its comment. Add the catalog entries, the five model builders, `PLAN_HEIGHT` entries and the material. The editor's palette and department select read the catalog, so they need no change.

- [ ] **Step 4: Run the full suite and build**

Run: `rtk proxy npm test && rtk proxy npm run build`
Expected: PASS. Any existing test changed needs a stated reason in the commit.

- [ ] **Step 5: Commit** as `feat(office): kitchen, dining and prayer departments and furniture`

Screenshot for the PR: the five new items placed through the editor's palette, on a temporary data folder.

### Task 2: Default layout and schema 2 migration

**Files:**
- Create: `src/layout/breakAreas.ts`, `src/layout/breakAreas.test.ts`
- Modify: `src/layout/types.ts`, `src/layout/defaultLayout.ts`, `src/layout/defaultLayout.test.ts`, `src/layout/storage.ts`, `src/layout/storage.test.ts`, `src/editor/summary.ts`, `server/layoutStore.test.ts`, `server/http/layoutRoutes.test.ts`, and any test pinning 10 rooms or schema 1, with the reason stated in the commit

**Interfaces:**
- Consumes: Task 1's types and `BREAK_DEPARTMENTS`
- Produces: `LAYOUT_SCHEMA_VERSION = 2`
- Produces in `breakAreas.ts`: `breakAreaItems(): { rooms: Room[]; furniture: Furniture[] }` (fresh objects, the full set at default placement), `compactBreakArea(department: BreakDepartment): { room: Room; furniture: Furniture[] }` (fresh objects, centred on the origin, to be moved by offset), `findRoomSpot(layout: OfficeLayout, width: number, depth: number): { x: number; z: number } | null`, and `withBreakAreasIfTheyFit(layout: OfficeLayout): OfficeLayout` (the same reference when nothing is added)

**Owner's decision (2026-11-07):** this overrides the spec's single placement. The full set is for an office the size of the default one. A small office gets a compact set beside its existing rooms, because 16 chairs and 15 mats 17 m away make no sense for a two-agent company.

Full set, default placement. Rooms use `DEFAULT_WALL_HEIGHT`, rotation 0, and the department's colour. These clear plant-11 at (1.2, 7.5), so an unedited older office fits without moving it.

| Room ID | Name | Department | Centre | Width × depth |
|---|---|---|---|---|
| `room-prayer` | PRAYER ROOM | `prayer` | (−4.0, 6.8) | 3.6 × 3.6 |
| `room-kitchen` | KITCHEN | `kitchen` | (0.3, 5.2) | 2.6 × 3.4 |
| `room-dining` | DINING AREA | `dining` | (3.2, 5.8) | 2.8 × 4.6 |

| Furniture IDs | Position and rotation |
|---|---|
| `kitchen-counter-01` | (0.3, 3.92), rotation 0 |
| `coffee-machine-01` | (−0.4, 3.92), rotation 0 |
| `dining-table-01`, `-02` | (3.2, 4.75) and (3.2, 6.95), rotation 90 |
| `dining-chair-01` to `-16` | For each table, z = table z + −0.75, −0.25, 0.25, 0.75. West side x 2.58, rotation 270. East side x 3.82, rotation 90. So 16 seats for 14 desks |
| `prayer-mat-01` to `-15` | x in −5.15, −4.0, −2.85; z in 5.48, 6.14, 6.8, 7.46, 8.12; rotation 90. Rotation 90 faces west, the nearest quarter turn to the qibla at about 295° |

Compact set, positions relative to the room centre. Room IDs, names and departments are the same as the full set, and furniture IDs follow the same pattern.

| Room | Width × depth | Furniture |
|---|---|---|
| `kitchen` | 2.6 × 2.4 | Counter at (0, −0.78), rotation 0. Coffee machine at (−0.7, −0.78), rotation 0 |
| `dining` | 2.6 × 2.4 | Table at (0, 0), rotation 0. Chairs at x ±0.5: z −0.62 with rotation 180, and z 0.62 with rotation 0. So 4 seats |
| `prayer` | 2.6 × 2.4 | Mats at x ±0.6 and z ±0.4, rotation 90. So 4 mats |

`findRoomSpot` returns the first candidate that is inside the office floor, 0.25 m clear of every room and every piece of furniture, not within 1 m of another room's open side, and has a clear 1 m strip inside the floor along its own south side, since rooms open to the south. Candidates, in order:
1. For each existing room, newest first: directly east of it with a 0.25 m gap and the same north edge, then directly west, then directly south with a 1.25 m gap and the same west edge.
2. A 0.5 m scan of the whole floor, north to south and then west to east.

So rooms added one after another form a row.

`withBreakAreasIfTheyFit` returns its argument if any existing room has a break department, or if any new ID is already used. Otherwise:
1. If the office has 6 or more desks and every full-set room is inside the floor and overlaps no existing room or furniture (using `rectsOverlap`), add the full set.
2. Otherwise add the compact rooms in the order kitchen, dining, prayer, each using `findRoomSpot` on the layout so far.
3. If any of the three has no spot, return the argument unchanged, because it's all three or none.

The owner's office must give this exact result: one room `room-ceo-office` at (−9.75, −8.2), 5.5 × 3.6, on the 25 × 20 floor, gives kitchen centre x −5.45, dining x −2.6, prayer x 0.25, all at z −8.8, north edge −10.

`migrateLayout(raw)`: if `raw` is an object with `schemaVersion === 1`, parse it with the version replaced by 2. If that parses, return `withBreakAreasIfTheyFit` of it. If not, return `raw` unchanged, so it reads as corrupt as it does today. Everything else passes through. Do not write the upgraded layout anywhere on load.

`summarizeLayout`: leave break departments out of `departments`, so the sidebar's Departments list stays people's departments. `roomCount` still counts them.

- [ ] **Step 1: Write the failing tests**

```ts
// breakAreas.test.ts
const v1Default = () => { /* createDefaultLayout() minus break rooms and furniture, schemaVersion 1 */ }
it('every piece of furniture is inside its room', ...)
it('chairs face their table, west chairs rotation 270 and east chairs 90', ...)  // use rotateOffset(0, -1, rotation) to get the facing
it('the default layout has no placement warnings', ...)                           // findIssues(createDefaultLayout()) is empty
it('every room keeps its open south side clear of other rooms and furniture', ...) // a 1 m strip south of each room
it('there are at least as many dining chairs and prayer mats as default desks', ...)
it('an office with 6 or more desks and free default spots gets the full set', ...)
it('a two-desk office gets the compact set in a row beside its room', ...)        // the exact numbers above
it('a large office with something on a default spot gets the compact set, and nothing moves', ...)
it('compact furniture stays inside its room with no placement warnings, and chairs face the table', ...)
it('adds nothing and returns the same object when there is no room for all three', ...)  // a floor filled with rooms; a floor too small: office 6 × 6 with a 5 × 5 room
it('adds nothing if an ID is taken, or a break room already exists', ...)
// storage.test.ts
it('an unedited schema 1 office gains all three rooms and moves nothing', ...)    // every old room and item deep-equal
it('a schema 1 office where they do not fit loads exactly as saved, at schema 2', ...)
it('a schema 2 layout with no break rooms is not given them', ...)                // Review Focus 3
it('a damaged schema 1 layout still reads as corrupt', ...)
it('a schema 3 layout is unsupported', ...)                                       // replaces the existing schema 2 case
it('an upgraded layout loads with no unsaved changes', ...)                       // isDirty is false
// server/layoutStore.test.ts
it('a schema 1 file loads upgraded, and its bytes stay the same until a save', ...)
it('after a save the file is schema 2, and reopening does not add a deleted room back', ...)
```

Add a `summary` test that break rooms count as rooms but aren't listed as departments.

- [ ] **Step 2: Run them to verify they fail**

Run: `rtk proxy npx vitest run src/layout server/layoutStore.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as above, with `createDefaultLayout` appending `breakAreaItems()`. Default totals are 13 rooms and 97 furniture items.

- [ ] **Step 4: Run the full suite and all builds**

Run: `rtk proxy npm test && rtk proxy npm run build && rtk proxy npm run server:build`
Expected: PASS.

- [ ] **Step 5: Commit** as `feat(layout): break areas in the default office and layout schema 2`

Screenshots for the PR: 3D and floor plan, on a temporary data folder that starts from a real schema 1 file.

### Task 3: "Add break areas"

**Files:**
- Modify: `src/layout/breakAreas.ts`, `src/layout/breakAreas.test.ts`, `src/editor/useEditorActions.ts`, `src/App.tsx`

**Interfaces:**
- Consumes: Task 2's `breakAreaItems`
- Produces in `breakAreas.ts`: `missingBreakDepartments(layout: OfficeLayout): BreakDepartment[]`, `breakAreasNotice(layout: OfficeLayout): string | null`, and `addBreakAreas(layout: OfficeLayout): OfficeLayout`
- Produces in `useEditorActions`: `addBreakAreas(): void`, one undo step that selects the first room added

`addBreakAreas` adds only the missing rooms, and returns the same reference if none are missing. It uses the compact set, because an office reaching this path didn't fit the full set or removed a room on purpose. Each room's furniture moves with it by the same offset, and `furniture.roomId` is the new room's ID. Each room goes to:
1. The spot from `findRoomSpot`.
2. If that is null, the office centre clamped to the floor with `clampRoom`, where the editor's normal overlap warnings show and the person can move it.

Rooms added earlier in the same call count as occupied. A taken ID gets a `-2`, `-3` suffix, chosen deterministically, because this runs inside the reducer. The result must pass `parseLayout`.

Notice copy, exactly: `This office has no {list}, so agents will stay at their desks for those breaks.` The list comes from the missing rooms, in the order `kitchen`, `dining area`, `prayer room`, joined as "kitchen", "kitchen or dining area", or "kitchen, dining area or prayer room".

In `App.tsx`, show it as a `scene-notice` when `editor.phase === 'ready'`, not editing, the notice isn't null and it hasn't been dismissed. It has an "Add break areas" button and the same close button as the other notices. The button enters edit mode the same way "Edit layout" does and calls `actions.addBreakAreas()`, so the result is reviewed and saved by the person. Dismissal is remembered per browser under `ai-virtual-office:break-areas-notice:dismissed`, using `getBrowserStorage()` inside try/catch, and the page must work without storage.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists what is missing', ...)                                     // none, one, two and all three, exact copy
it('adds only the missing rooms and moves nothing that exists', ...)
it('uses the compact set beside the existing rooms, furniture moving with its room', ...)
it('rooms added in one call do not overlap each other', ...)
it('on a floor with no free spot it still gives a valid layout inside the floor', ...)  // parseLayout succeeds
it('a taken ID gets a suffix', ...)
it('returns the same object when nothing is missing', ...)
it('gives the same result every time', ...)                          // StrictMode runs reducers twice
```

- [ ] **Step 2: Run them to verify they fail**

Run: `rtk proxy npx vitest run src/layout/breakAreas.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as above.

- [ ] **Step 4: Run the full suite and build**

Run: `rtk proxy npm test && rtk proxy npm run build`
Expected: PASS.

- [ ] **Step 5: Commit** as `feat(editor): offer to add break areas when an office has none`

Screenshots for the PR: the notice, then the editor after clicking it, on a layout that has no break rooms at schema 2.

### Task 4: Check in a real browser (done by the controller, not an implementer)

Run on a temporary `DATA_DIR` with the mock runtime, never the real `data/`.

- [ ] **Upgrade of the default office:** a real schema 1 `layout.json` written from `main` before this slice gets the full set. Nothing moves. The status says Saved, and the file's bytes are unchanged until a save.
- [ ] **Upgrade of a two-desk office:** a schema 1 file with one corner office and mock agents gets the compact row beside it. Use mock agent names, never the owner's real `data/`.
- [ ] **Upgrade with no room:** a schema 1 file with a floor too full for all three. It loads exactly as saved and the notice shows. "Add break areas" works, can be undone, and saves. Dismissing the notice lasts across a reload.
- [ ] **Delete and reload:** delete the kitchen, save and reload. It stays gone.
- [ ] **The rooms:** open sides face a clear floor, walls don't cut through furniture, and the labels are readable in 3D and floor plan. Characters still sit at all 14 desks.
- [ ] **Editing:** add each new furniture type, and select, drag and save. A dragged room carries its furniture.
- [ ] **Cost:** `?stats` before and after, with 14 desks occupied. If draw calls rise by more than about 25%, instance the dining chairs and mats or raise it with the owner.
- [ ] **Docs:** `README.md` mentions the break rooms and the notice. `MASTER-ROADMAP.md` records slice 4 as built, not complete.
- [ ] Open the PR and ask the owner to look at the three rooms.
