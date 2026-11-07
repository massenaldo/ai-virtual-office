# Seated Characters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent with a desk appears as a stylized 3D character at that desk, showing its real status, and the office keeps animating without turning a laptop's fan on.

**Architecture:** Pure modules decide everything: where the seat is, how a character looks, what its joints do, how fast to draw. One component draws every character with one `InstancedMesh` per body part, so draw calls depend on the number of part types and not the number of agents. Nothing is stored and nothing touches the server: characters are worked out from the layout and workforce state the browser already has.

**Tech Stack:** TypeScript, React 19, three 0.174, @react-three/fiber 9, drei 10, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-office-presence-daily-life-design.md`, sections 4, 6.4 and 6.7. This is slice 3 of section 7.

## Global Constraints

- No Claude call, API cost or model session may be created by characters. **This slice changes no file under `server/`.**
- 3D is built in code with no downloaded assets (`src/scene/noRemoteAssets.test.ts` stays in force).
- Appearance comes only from the agent's ID. It must not read `takesPrayerBreaks`: "appearance says nothing about an agent's prayer setting".
- Hijab is one option among women's looks, not the default. Men and women, skin tone, hair and clothing cut all vary. Clothing accent uses the agent's department colour. No facial detail beyond simple features.
- One character per agent with an existing desk. No desk or a missing desk means no character.
- Edit mode: characters are hidden. Floor plan: a simple coloured dot. Editing must not get worse.
- Desk clicks keep working. Clicking a character does what clicking its desk does. The status label stays above the character.
- Draw rates: 30 fps while anything animates and the tab is visible, 5 fps when every character is seated and idle, 0 when the tab is hidden.
- The scene never imports workforce types (existing rule, see `src/scene/labels.ts`).
- Out of scope: walking, routine, chat, coffee, lunch, prayer, break rooms, holding tasks.
- Conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work in place on `feat/seated-characters`.

## Review Focus

1. A desk rotated 90° or 270°, or moved: the character sits on the correct side and faces the desk, not at a hard-coded +Z offset.
2. A chair moved away or deleted: the character stands at the desk instead of floating, and its label clears its head.
3. Two agents with the same desk ID, or a desk deleted while an agent points at it: one character per desk, none for the missing desk, and no crash.
4. A tab hidden for an hour and then shown: nothing draws while hidden, and the first frame back doesn't overshoot or jump wildly.
5. A page reload after a task finished long ago, or a `completedAt` that is invalid or in the future: no done gesture plays, and nothing throws.

---

### Task 1: Seat position and character look

**Files:**
- Create: `src/layout/seats.ts`, `src/layout/seats.test.ts`, `src/scene/characterLook.ts`, `src/scene/characterLook.test.ts`
- Modify: `src/layout/defaultLayout.ts` (export `CHAIR_OFFSET_Z`), `src/scene/furnitureModels.ts` (export the hash from `plantVariant` as `stableHash(text: string): number`, behaviour unchanged), `src/scene/labels.ts`, `src/scene/labels.test.ts`, `src/workforce/view.ts`, `src/workforce/view.test.ts`

**Interfaces:**
- Produces: `Seat = { x: number; z: number; rotation: number; seated: boolean }` and `seatForDesk(layout: OfficeLayout, desk: Furniture): Seat`
- Produces: `CharacterLook = { body: 'man' | 'woman'; skin: string; hair: 'short' | 'side' | 'bun' | 'long' | 'hijab'; hairColor: string; cut: 'shirt' | 'blazer' | 'sweater' | 'tunic'; clothing: string; trousers: string }` and `characterLook(id: string): CharacterLook`
- Produces: `DeskMarker` gains `seated: boolean`; `markerAnchor` uses `MARKER_HEIGHT` when seated and `STANDING_MARKER_HEIGHT = 1.9` when not

- [ ] **Step 1: Write the failing seat tests** in `src/layout/seats.test.ts`

```ts
const desk = (rotation: 0 | 90 | 180 | 270) => ({ id: 'd', type: 'desk', x: 0, z: 0, rotation, roomId: null }) as const
it.each([[0, 0, 0.56], [90, 0.56, 0], [180, 0, -0.56], [270, -0.56, 0]] as const)('with no chair, rotation %i stands at the seat point', (r, x, z) => {
  expect(seatForDesk(layoutWith([desk(r)]), desk(r))).toEqual({ x, z, rotation: r, seated: false })
})
it('sits in a chair moved within 0.9 m of the seat point', ...)      // chair at (0.3, 0.9): { x: 0.3, z: 0.9, seated: true }
it('does not use a chair further than 0.9 m away', ...)              // chair at (0, 2): seated false
it('ignores meeting chairs', ...)
it('every default desk sits in its own chair', ...)                  // 14 desks, seat equals chair-NN position, 14 distinct seats
```

- [ ] **Step 2: Write the failing look tests** in `src/scene/characterLook.test.ts`

```ts
const looks = Array.from({ length: 2000 }, (_, i) => characterLook(`agent-${i}`))
const women = looks.filter((l) => l.body === 'woman')
it('is stable for an id', ...)
it('has men and women, each 35–65%', ...)
it('hijab is on some women, between 15% and 45% of them, and on no men', ...)
it('uses every skin, hair and cut option', ...)
it('takes only the id', () => expect(characterLook.length).toBe(1))
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/layout/seats.test.ts src/scene/characterLook.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `seats.ts` and `characterLook.ts`**

The seat point is the desk position plus `CHAIR_OFFSET_Z` along the desk's rotation: `x + off * sin θ`, `z + off * cos θ`, rounded to 2 decimals. Take the nearest `chair` within 0.9 m of that point, using the chair's x and z. `rotation` is always the desk's, so the character faces the desk. Hash each trait with its own salt (`stableHash(`${id}:skin`)`) so traits don't move together. Hair, hijab and cut are chosen from per-body lists. Keep the clothing palette smart-casual and neutral, since the department colour is added as the accent in Task 3.

- [ ] **Step 5: Move labels to the seat**

`deskMarkers` uses `seatForDesk` for `x`, `z` and `seated`. Update the marker expectations in `view.test.ts`, with the commit message stating why: the label must stay above the character. Add a `labels.test.ts` case for the standing height.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/layout src/scene src/workforce/view.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit** as `feat(office): seat positions and character looks from the agent id`

### Task 2: Rig, poses and actions

**Files:**
- Create: `src/scene/characterRig.ts`, `src/scene/characterRig.test.ts`

**Interfaces:**
- Consumes: `CharacterLook` from Task 1
- Produces: `CharacterAction = 'idle' | 'typing' | 'thinking' | 'waiting' | 'error' | 'done'`
- Produces: `CharacterStatus = 'idle' | 'working' | 'thinking' | 'waiting' | 'error'`
- Produces: `DONE_GESTURE_MS = 4000` and `characterAction(status: CharacterStatus, doneAt: number | null, nowMs: number): CharacterAction`
- Produces: `Pose` (a flat record of joint angles), `targetPose(action: CharacterAction, seated: boolean, timeS: number, phase: number): Pose` and `stepPose(current: Pose, target: Pose, dtS: number): { pose: Pose; settled: boolean }`
- Produces: `JOINTS` (hips, spine, head, upper arms, forearms, thighs, shins) and `jointMatrices(pose: Pose, out: THREE.Matrix4[]): void`, which writes each joint's matrix relative to the character's origin, standing on y = 0 and facing −Z
- Produces: `CHARACTER_PARTS: { part: CharacterPart; joint: Joint; geometry: THREE.BufferGeometry; castShadow: boolean }[]`, built once and shared, and `partColor(part: CharacterPart, look: CharacterLook, accent: string): string | null`, where null means this look doesn't use that part

- [ ] **Step 1: Write the failing tests**

```ts
// The world position of a point on a joint, using jointMatrices and targetPose(action, true, 0, 0).
describe('characterAction', () => {
  it('maps each status', ...)                                       // working→typing, thinking→thinking, waiting→waiting, error→error, idle→idle
  it('idle within 4 s of doneAt is done', () => expect(characterAction('idle', 1000, 4999)).toBe('done'))
  it('at 4 s it is idle', () => expect(characterAction('idle', 1000, 5000)).toBe('idle'))
  it('a future doneAt is idle', () => expect(characterAction('idle', 9000, 1000)).toBe('idle'))
  it('a status other than idle beats doneAt', ...)
})
describe('seated body', () => {
  it('feet are on the floor', ...)                                  // shin end |y| ≤ 0.06
  it('hips are at the chair seat', ...)                             // 0.48 ≤ hip y ≤ 0.60
  it('the head top is under the label', ...)                        // 1.10 ≤ top ≤ 1.38
  it('typing puts both hands at the keyboard', ...)                 // within 0.15 m of (±0.1, 0.78, −0.44)
  it('waiting raises one hand above the head', ...)
  it('error drops the head below its idle height', ...)
})
it('standing head top is at most 1.85', ...)                        // clears STANDING_MARKER_HEIGHT
describe('stepPose', () => {
  it('moves toward the target without passing it', ...)
  it('a one-hour step lands exactly on the target and is settled', ...)
  it('is settled when nothing moves', ...)
})
it('a whole character is at most 2500 triangles', ...)
it('there are at most 20 parts', ...)
it('every look has one hair or hijab part, and the accent part uses the accent colour', ...)
it('the badge part is only drawn in the error action', ...)         // see Step 3
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/scene/characterRig.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `characterRig.ts`**

Use rounded shapes (`CapsuleGeometry`, `SphereGeometry`) with low segment counts, modelled in each joint's local space. Hands, feet, eyes, hair, the hijab and the accent are separate parts because they take different colours. Simple eyes are the only facial detail. The error badge is a part on the head joint, floating above it; the renderer writes it only for `error`, so `partColor` alone doesn't decide it. Add `partVisible(part, action): boolean` for this.

`targetPose` adds slow breathing and small head movement for idle, faster finger and forearm motion for typing, a hand to the chin for thinking, a raised arm for waiting, a slumped spine and head for error, and a raised fist or small arm lift for done. `phase` keeps characters out of step with each other. Exact angles are left to you, within the tests. `stepPose` is an exponential approach with `dtS` clamped, snapping to the target when within a small tolerance.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/scene/characterRig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** as `feat(office): character rig, poses and status actions`

### Task 3: Characters in the office

**Files:**
- Create: `src/scene/Characters.tsx`, `src/scene/characterInstances.ts`, `src/scene/characterInstances.test.ts`
- Modify: `src/workforce/view.ts`, `src/workforce/view.test.ts`, `src/scene/OfficeScene.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: `Seat`, `characterLook`, the rig from Task 2
- Produces: `SceneCharacter = { id: string; deskId: string; x: number; z: number; rotation: number; seated: boolean; status: CharacterStatus; doneAt: number | null; accent: string }`, declared in `src/scene/characterInstances.ts`
- Produces: `deskCharacters(layout: OfficeLayout, s: WorkforceState): SceneCharacter[]` in `view.ts`
- Produces: `buildPartInstances(characters: SceneCharacter[]): Map<CharacterPart, { characterIndex: number; color: string }[]>`
- Produces: `motion: MutableRefObject<{ active: boolean }>`, written by `Characters` every frame and read by Task 4. `active` is true when any character's action isn't `idle` or its pose hasn't settled.
- Produces: `OfficeSceneProps.characters?: SceneCharacter[]`. Clicks reuse the existing `onDeskClick`.

- [ ] **Step 1: Write the failing tests**

```ts
// view.test.ts
it('one character per occupied desk at its seat', ...)
it('no character for an agent with no desk or a missing desk', ...)
it('two agents on one desk give one character, the same agent the marker shows', ...)
it('accent is the department colour', ...)
it('doneAt is the time of a completed current task of an idle agent', ...)
it('doneAt is null for a failed or cancelled task, or a working agent', ...)
it('an unparseable completedAt gives doneAt null', ...)
// characterInstances.test.ts
it('no characters gives no instances', ...)
it('each character appears once in each part it uses and never in parts it does not', ...)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/workforce/view.test.ts src/scene/characterInstances.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `deskCharacters` and `buildPartInstances`**

- [ ] **Step 4: Implement `Characters.tsx`**

Render one shared white `MeshStandardMaterial` and one `<instancedMesh>` per part, keyed by instance count so a new count builds a new mesh. Set colours once per `characters` change with `setColorAt`. In one `useFrame`, for each character: get the action and target, call `stepPose`, call `jointMatrices`, and multiply by the character's root matrix. Then write each part's instance matrix, hiding parts `partVisible` rules out by scaling to zero. Measure `dtS` from the previous frame.

Instanced meshes need two things or clicks and visibility go wrong:
- `frustumCulled={false}`, because the instances move.
- A fresh `computeBoundingSphere()` after writing matrices whenever placement changes. Three caches the sphere it raycasts against.

Pointer handlers exist only when `onDeskClick` is passed. Map `e.instanceId` through the part's instance list to the character's `deskId`. Apply the same `CLICK_SLOP` check and `stopPropagation` as `FurnitureItem`, and the same pointer-cursor handling. Export `CLICK_SLOP` rather than copying it.

In floor plan, render one instanced flat circle per character in its `accent` colour at y = 0.09 (above the monitor tile) instead of the body parts. Dots keep the same click behaviour.

- [ ] **Step 5: Wire it up**

`OfficeContents` renders `{!editing && characters && <Characters ... />}`. `App.tsx` computes `characters` with `useMemo`, the same way as `markers`, and only when not editing. An effect in `Characters` calls `invalidate()` when `characters` changes, because rendering is on demand.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS, with only the existing chunk-size warning.

- [ ] **Step 7: Commit** as `feat(office): show agents as seated characters at their desks`

### Task 4: Draw-rate policy

**Files:**
- Create: `src/scene/drawRate.ts`, `src/scene/drawRate.test.ts`, `src/scene/DrawScheduler.tsx`
- Modify: `src/scene/OfficeScene.tsx`, `README.md`, `MASTER-ROADMAP.md`

**Interfaces:**
- Consumes: `motion` from Task 3
- Produces: `ACTIVE_FPS = 30`, `IDLE_FPS = 5` and `drawRate(s: { hidden: boolean; editing: boolean; floorPlan: boolean; characters: number; active: boolean }): number`

- [ ] **Step 1: Write the failing tests**

```ts
const base = { hidden: false, editing: false, floorPlan: false, characters: 3, active: false }
it('idle characters draw at 5', () => expect(drawRate(base)).toBe(5))
it('anything active draws at 30', () => expect(drawRate({ ...base, active: true })).toBe(30))
it.each([{ hidden: true }, { editing: true }, { floorPlan: true }, { characters: 0 }])('%o never draws on a timer', (o) => {
  expect(drawRate({ ...base, active: true, ...o })).toBe(0)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/scene/drawRate.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `drawRate.ts` and `DrawScheduler.tsx`**

The Canvas stays `frameloop="demand"`, so orbiting and dragging still draw at full speed through their own `invalidate` calls. `DrawScheduler` sits inside the Canvas and runs a `setTimeout` chain. Each tick reads `motion.current.active`, works out the rate, calls `invalidate()`, and schedules the next tick at `1000 / rate`. At rate 0 no timer runs. Restart on a `visibilitychange` event or when `editing`, `floorPlan` or the character count changes. Clear the timer and listener on unmount.

- [ ] **Step 4: Stop the contact shadows redrawing every frame**

Under continuous drawing, `ContactShadows` would re-render the whole scene's depth on every frame. Pass `frames={editing ? Infinity : 2}`, and a `key` of `'editing'` while editing, otherwise of the memoised `serializeLayout(layout)` plus `floorPlan`, so a layout change while not editing still updates the shadows.

- [ ] **Step 5: Update the docs**

`README.md`: agents appear as characters at their desks, and `?stats` is how to read the draw cost. `MASTER-ROADMAP.md`: update the M3B.6 + M3C.1 row to say seated characters are built, with the owner's review pending. Do not mark it complete.

- [ ] **Step 6: Run the full suite and all builds**

Run: `npm test && npm run build && npm run server:build && npm run check:secrets`
Expected: PASS. `git diff --stat main -- server/` shows no changes.

- [ ] **Step 7: Commit** as `feat(office): cap the draw rate and stop it when nothing needs drawing`

### Task 5: Check in a real browser (done by the controller, not an implementer)

Run on a temporary `DATA_DIR` with the mock runtime, never the real `data/`.

- [ ] Take `?stats` numbers on `main`'s build first and then on this branch, with all 14 desks occupied: idle fps, ms CPU, calls and triangles.
- [ ] Confirm seated characters on all 14 desks, including rotated desks and a removed chair.
- [ ] Run a mock task and watch typing, thinking, waiting and done. Force an error and check the slump and badge.
- [ ] Hide the tab and confirm drawing stops.
- [ ] Click a character with the agents panel open. Click a desk. Check floor plan dots.
- [ ] In edit mode, confirm characters are gone and selecting, dragging and saving still work.
- [ ] Open the PR, then ask the owner to look at the characters, as section 8 of the spec requires.
