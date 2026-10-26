# Room Rotation and Tower Floor Slab — Design

**Date:** 2026-10-26 · **Status:** approved in chat by the user ("it's perfect"); this document writes that agreement down.

## Intent

The office is meant to read as **one storey of a tower**: a solid building floor with its own base colour, with rooms placed on top, each with its own floor finish. Today the office floor is almost the same light grey as the background, so the building has no visible edge.

While laying out that storey, the user wants to **turn a room as a whole**, the way they already turn furniture. Its walls, glass, details and all its furniture follow the room.

## Goals

1. **Rotate room:** in edit mode, a selected room can be turned in 90° steps. Walls, glass, frames, wall details (whiteboard, art), the room floor, the department accent strip, the open front side and every furniture item assigned to the room all turn together, around the room's centre.
2. **Tower floor slab:** the office stands on a solid slab the size of the office (`office.width × office.depth`, 25 × 20 m by default), in **warm concrete**, clearly darker than the background, with a visible slab edge. Rooms keep their own department floors on top; open areas show the slab.

## Non-goals

- Free-angle room rotation. Only quarter turns.
- An editable slab colour. It is fixed (my call; the user didn't ask for it to be editable).
- Changing the floor-plan look. Floor plan keeps its plain light sheet so it stays readable.
- Multiple storeys, a building core, columns, façades or windows.
- A keyboard shortcut for rotating (not requested; furniture has none either).

## Anti-goals (would make this a failure even if it technically works)

- Furniture left behind or misplaced when a room turns, or a room's arrangement that no longer matches what was there before the turn.
- Saved layouts failing to load, being reset, or changing on load.
- Selection outlines, resize handles, overlap warnings or snapping disagreeing with what the 3D view shows for a rotated room.
- A slab colour that makes the office look washed out again, or that clashes with the room floors.

## Decided (by the user, in chat)

- Rotate button for a selected room, in edit mode, turning in 90° steps like furniture's **Rotate 90°**.
- Walls and furniture follow the room.
- **Room size limit becomes 12 × 12 m** (was 12 m wide × 10 m deep), so a turn never needs to shrink a room (answered after the design review). Update `ROOM_LIMITS.maxDepth` in `src/layout/catalog.ts`, the size hint in the properties panel (it reads from `ROOM_LIMITS`), the README ("2–12 m wide and 2–10 m deep") and the tests that pin 10 m. Rooms must still fit inside the office, so the real cap stays `min(12, office.depth)`.
- Slab colour: option **B, warm concrete** (realistic, mid-grey, clearly darker than the background, visible edge). Rejected: A, dark slate matching the app panels; C, muted lavender from the brand accent. The mockup values were top `#b9b3aa`, edge `#9e978d`, underside `#8f8a83`. They are a starting point, to be tuned under the scene's lighting.

## My calls (agreed by the user when the summary was played back)

- **Footprint stays in world space.** `room.width` / `room.depth` keep meaning the footprint's size along world X / Z, exactly as today. A new `room.rotation` (0 | 90 | 180 | 270) only orients the shell inside that footprint. A rotation of 90° or 270° therefore swaps width and depth. A 4.3 × 2.4 m room becomes 2.4 × 4.3 m on the floor plan. As a result, `roomRect`, overlap checks, `roomAt`, resize handles (edges stay world n/s/e/w), snapping, clamping, labels and the floor-plan tile all keep working unchanged.
- **Rotation direction and convention match furniture:** `nextRotation` (+90°) and `rotateOffset` from `src/layout/geometry.ts`, the same convention as a three.js group with `rotation.y = degrees`.
- **Rotating a room** (one undoable step):
  1. swap width and depth;
  2. set `rotation = nextRotation(rotation)`;
  3. clamp the room inside the office (it slides back in if the turn would push it past an edge);
  4. move every furniture item with `roomId === room.id` to `newCentre + rotateOffset(item − oldCentre, 90)`, set its rotation to `nextRotation(item.rotation)`, and clamp it as furniture is clamped today.

  The room never grows or shrinks; it only turns. With 12 × 12 m limits inside a 25 × 20 m office, a swapped footprint always fits. Overlap with other rooms after a turn is a warning (the existing red outline and issue list), not a block.
- **Furniture keeps its room on a turn.** Turned items keep their `roomId` and are never re-assigned through `roomAt`.
- **Four turns restore the room exactly.** Four rotations bring the room and its furniture back to their original values when no edge clamping happened, with no drift from the 0.5 cm room / 1 cm furniture rounding steps. A test pins this.
- **Saved data:** `rotation` is added to `Room` and saved. A saved room without `rotation` loads as `0`, and a value outside 0/90/180/270 makes the room invalid, the same rule furniture follows. The schema version stays **v1**, as in milestone 2 decision 4. Old saves load unchanged, and **an old save must not show "Unsaved changes" just because it has no `rotation` field**. The dirty check compares freshly serialized text with the stored text, so that comparison must treat a missing room rotation as 0. Rooms from templates and the default office start at `0`, so the default office looks exactly as it does now.
- **3D:** the room's shell (walls, glass, frames, baseboards, details, floor slab and its texture, accent strip) is built in the room's own frame with local width/depth (swapped back for 90°/270°) and turned by `rotation`. The selection outline and floor-plan tile stay world-aligned on the footprint, so they match what the 3D view shows.
- **UI:** a **Rotate 90°** button in the room's properties panel, styled like the furniture one, next to **Delete room**.
- **Tower floor slab:** in 3D only, a box the size of the office whose top face sits at y = 0 (where furniture stands today). It is roughly 0.3 m thick, going downward. The top is warm concrete; the sides are a darker edge colour so the slab reads as a cut building floor. It receives shadows. The current concrete texture can be reused on the top if it still reads as concrete at the darker colour. Floor plan keeps its existing plain sheet. The slab follows `office.width` / `office.depth`.

## Constraints

- Matches the project's milestone 2 rules: no new dependencies, no remote assets, procedural only, shared materials and geometry, merged room parts (Stage D), render on demand (`frameloop="demand"`). Any new animation or async work must invalidate a frame.
- The editor regression checklist in `tasks.md` must still pass, plus the new rotate behaviour in both views.
- Walls, glass, frames and details still never catch pointer events.
- Conventional commits; one branch (`feat/room-rotation-floor-slab`) and one PR into `main`, with before/after screenshots.

## Left to the builder

- Exact slab thickness, colours and roughness under the real lighting, as long as it reads as option B: clearly darker than the background, with a visible edge, and not clashing with the room floors.
- Whether the slab top reuses the concrete texture or is plain.
- How the rotated shell is implemented: a rotated group with swapped local dimensions, or rotating the boxes inside `architecture.ts`. Both are fine if the tests prove walls, frames and details stay inside the footprint for all four rotations.
- Exact placement and copy of the button, within the existing properties-panel style.
- Test structure, following the existing Vitest suites (`operations.test.ts`, `storage.test.ts`, `architecture.test.ts`).
