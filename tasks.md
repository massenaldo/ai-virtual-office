# Task: Implement the Virtual Office Layout Editor

You are working inside my existing repository: `ai-virtual-office`.

## Project context

This is a self-hosted 3D AI virtual office built with React 19, TypeScript, Vite, Three.js, React Three Fiber, and Drei.

The current application already has:
- A dark dashboard UI and department sidebar.
- An existing 3D office scene with rooms, desks, chairs, monitors, plants, and department labels.
- Orbit, zoom, and pan camera controls.
- A 3D overview and top-down floor-plan view.
- A Save layout button that currently does not persist the complete editable geometry.
- A Claude Code `/vo` command for starting the app and opening the browser.

Keep the existing visual identity and office scene. Do not replace the application with a new starter template.

## Goal

Turn the existing prototype into a functional, browser-based 3D office layout editor. The user must be able to customize the physical office layout, see the changes in 3D, save them, and restore them after restarting the application.

## Phase 1: Inspect before implementing

1. Inspect the repository structure, current scene components, room definitions, furniture components, styles, and save-layout implementation.
2. Identify how the existing scene is constructed and where the current layout data lives.
3. Reuse existing components and dependencies wherever practical.
4. Write a short implementation plan based on the actual code before making changes.
5. Preserve existing `/vo` behavior and avoid unrelated refactors.

## Phase 2: Editor interface

Add an Edit Layout mode with:

- A top toolbar containing Edit Layout, 3D View, Floor Plan, Undo, Redo, Save, and Reset.
- A left sidebar or panel listing all rooms and furniture.
- A contextual properties panel for the selected object.
- Clear visual feedback for selection, hover, dragging, and invalid placement.
- A grid and snap-to-grid option in floor-plan mode.
- A cancel/exit editing action that does not silently discard unsaved changes.

The interface must remain usable at typical desktop browser sizes.

## Phase 3: Room editing

Implement the following operations using the existing room model where possible:

- Select a room by clicking it in the scene or room list.
- Move rooms on the horizontal X/Z plane.
- Resize room width and depth with visible handles or numeric properties.
- Rename rooms and edit their department labels.
- Add rooms using a predefined room template.
- Delete rooms with confirmation when appropriate.
- Edit room dimensions and position using a properties panel.
- Enforce minimum and maximum dimensions and prevent invalid coordinates.
- Make room changes visible immediately in both 3D and floor-plan views.

Use a consistent world-coordinate system. Clearly distinguish room footprint coordinates from wall height and other vertical dimensions.

If room geometry is currently made from primitive shapes, refactor it into reusable components driven by structured room data.

## Phase 4: Furniture editing

Support the existing furniture types first:

- Desk
- Chair
- Monitor
- Plant
- Meeting table

Implement:

- Click to select.
- Drag to move on the floor plane.
- Rotate in 90-degree increments.
- Duplicate.
- Delete.
- Add from a furniture palette.
- Edit position and rotation numerically.
- Snap to grid.
- Prevent or clearly warn about invalid placement and unintended furniture overlap.

Keep furniture attached to the correct room when appropriate, but allow moving furniture between rooms.

Use existing furniture components and geometry wherever possible. Do not introduce external 3D asset downloads as a requirement for this milestone.

## Phase 5: Data model and persistence

Create a typed, serializable office-layout model.

It should contain:
- A schema version.
- Office dimensions and settings.
- Room IDs, names, department types, positions, dimensions, and other necessary room properties.
- Furniture IDs, types, positions, rotations, dimensions or variants, and optional room associations.

Requirements:

1. Use stable IDs rather than array indices.
2. Make the 3D scene a rendering of the layout data, not the source of truth.
3. Persist the complete layout in localStorage.
4. Load a valid saved layout when the app starts.
5. Handle missing, invalid, or older saved data safely.
6. Keep a default layout that can be restored without destroying data until the user confirms.
7. Show clear Saved, Unsaved changes, and Save failed states.
8. Ensure the Save layout button actually saves all room and furniture geometry.
9. Never silently overwrite a valid saved layout with an invalid or partially initialized scene.

Use a versioned key such as `ai-virtual-office:layout:v1`.

## Phase 6: Undo and redo

Implement undo and redo for meaningful layout edits, including room movement, resizing, addition, deletion, and furniture changes.

- Support Ctrl+Z / Cmd+Z for undo.
- Support Ctrl+Shift+Z / Cmd+Shift+Z for redo.
- Avoid adding a history entry for every mouse-move frame; group one completed drag into one undoable operation.
- Set a reasonable history limit.
- Ensure undo and redo update the 3D scene and saved-state indicator correctly.

## Phase 7: Interaction quality

- In floor-plan editing mode, prefer predictable top-down dragging and resizing.
- In 3D editing mode, support selecting and moving objects without interfering with orbit controls.
- Provide Escape to cancel the current placement or selection operation where appropriate.
- Provide Delete/Backspace for the selected object, while preventing accidental browser navigation or unwanted deletion.
- Add confirmation for destructive reset operations.
- Keep normal camera navigation working when editing is disabled.
- Avoid adding a new state-management dependency unless the existing architecture genuinely requires it.

## Phase 8: Verification

After implementation:

1. Run the existing TypeScript/build checks.
2. Fix any new type errors and build failures.
3. Verify room and furniture changes render consistently in both views.
4. Verify Save and browser refresh restore the full layout.
5. Verify undo/redo, reset, and invalid-data handling.
6. Check that the existing `/vo` launch command still works.
7. Report which files changed, features implemented, tests run, and any remaining limitations.

Do not claim that a feature is verified unless you actually tested it.

## Scope boundaries

For this milestone, do not implement AI agents, backend APIs, authentication, multiplayer editing, or agent orchestration. Keep the layout editor local-first and architect it so these features can be added later.

Prioritize a working, maintainable editor over excessive abstraction. Implement in small steps, run checks frequently, and preserve the existing application throughout.