# Milestone 2 — Realistic Office Builder

We are continuing development of my existing self-hosted AI Virtual Office project.

Repository: https://github.com/massenaldo/ai-virtual-office

The Layout Editor milestone is complete. Your task is to implement Milestone 2: improve the visual quality of the existing 3D office until it looks like a professional, realistic modern technology office while preserving all existing layout-editing functionality.

## 1. Inspect before changing anything

First inspect the actual project:
- Read the project structure, package.json, existing 3D scene components, room and furniture models, layout schema, editor state, persistence, and camera controls.
- Identify how rooms and furniture are currently rendered and how layout changes propagate between the 3D view and floor plan.
- Run the current build and record any pre-existing errors.
- Identify the smallest set of files that need changes.

Do not assume file names or invent a new architecture before inspecting the code.

## 2. Visual direction

Design a realistic, premium architectural visualization of a modern technology office.

Style:
- Modern startup / technology company.
- Warm oak or walnut desks.
- Matte black or dark graphite metal frames.
- Neutral concrete, wood, or refined carpet flooring where appropriate.
- White and warm-grey walls.
- Glass meeting-room partitions with restrained frames.
- Ergonomic office chairs.
- Realistic monitors, keyboards, mice, desk accessories, plants, and subtle decorations.
- Natural-looking daylight combined with soft interior lighting.
- Professional, restrained colors; avoid a cartoon, toy, low-poly, or overly saturated appearance.

Maintain the existing dark application UI. The office scene itself should look like a real physical workplace.

## 3. Improve the environment first

Upgrade the existing scene with:
- Better floor materials and room-specific visual differentiation.
- More convincing wall thickness and corners.
- Baseboards and clean architectural edges where appropriate.
- Doors and glass partitions where they make sense.
- More realistic room proportions and object scale.
- Soft shadows, ambient occlusion where affordable, and balanced lighting.
- A coherent lighting setup without excessive brightness or crushed shadows.
- A clean background and a useful default camera angle.
- Clear room boundaries in both 3D and floor-plan views.

The scene must remain legible when zoomed out to view the entire office.

Do not add decorative details that make editing rooms or selecting furniture difficult.

## 4. Upgrade furniture models

Improve the existing procedural models first rather than replacing the whole scene.

Desks:
- Proper desktop thickness, legs or frame, and consistent dimensions.
- Realistic monitor stands, screens, keyboards, and mice.
- Optional drawers or cable-management details when appropriate.

Chairs:
- Seat, backrest, base, and wheels.
- A convincing ergonomic silhouette without excessive polygon complexity.

Other objects:
- Meeting tables and chairs.
- Plants with multiple leaves or a convincing foliage silhouette.
- Storage cabinets, shelves, and subtle desk accessories.
- Monitors with dark bezels and screen surfaces.

Use reusable model components, shared geometry, and shared materials where practical. Furniture must remain correctly positioned, scaled, rotated, duplicated, selected, and deleted through the existing editor.

Avoid creating every object from dozens of independent meshes if a reusable component or grouped geometry would work better.

## 5. Preserve the layout editor

This is a visual upgrade, not a rewrite.

All of the following must continue to work:
- Room selection, movement, resizing, and renaming.
- Furniture selection, movement, rotation, duplication, creation, and deletion.
- Undo and redo.
- Save and reload persisted layouts.
- Reset to the default layout with the existing confirmation behavior.
- Floor-plan and 3D synchronization.
- Existing grid and snapping behavior.
- Keyboard shortcuts.
- The current `/vo` startup workflow.

Any new visual properties that affect saved layouts must be represented in the existing typed layout schema with sensible defaults and backward-compatible migration.

Do not store transient Three.js objects or runtime references in persisted layout data.

Keep the existing layout schema and persistence format unless a concrete, necessary change is identified.

## 6. Camera and editor usability

- Preserve orbit, pan, and zoom in 3D view.
- Keep the entire office visible at the default overview.
- Ensure realistic shadows and materials do not obscure selection.
- Maintain readable room labels and selection outlines.
- Ensure top-down floor-plan editing remains practical and predictable.
- Keep selection and transformation controls usable even when furniture becomes more detailed.
- Avoid unnecessary changes to the existing UI.

## 7. Performance requirements

This must remain a responsive browser-based application.

- Reuse geometries and materials wherever possible.
- Avoid unnecessary per-frame React state updates.
- Avoid expensive real-time effects unless justified.
- Use sensible shadow-map settings and limit shadow-casting objects.
- Avoid adding a large dependency for something the current stack can handle.
- Do not load remote assets at runtime without a clear reason.
- Prefer procedural models and local assets so the project remains self-hosted.
- If external assets are genuinely needed, verify licensing and document their source and local installation requirements.
- Do not sacrifice basic editor responsiveness for visual effects.

## 8. Implementation sequence

Implement in small, testable stages:

Stage A: Improve lighting, materials, floor, walls, and architectural structure.

Stage B: Upgrade desks, chairs, monitors, and other furniture.

Stage C: Add glass partitions, doors, plants, and selected architectural details.

Stage D: Optimize rendering and verify editor interactions.

After each stage, run the relevant checks and fix regressions before continuing.

## 9. Acceptance criteria

The milestone is complete only when:

1. The office looks noticeably more realistic than the starting version.
2. Furniture has coherent proportions and materials.
3. The entire office still looks good in the overview camera.
4. Floor-plan mode remains clear and usable.
5. Moving or resizing rooms still updates the 3D scene correctly.
6. Furniture editing and selection still work with the upgraded models.
7. Save, refresh, and reload preserve the layout.
8. Undo, redo, and reset continue to work.
9. No unnecessary remote dependency is introduced.
10. The production build passes, for example `npm run build`, using the project's existing scripts.
11. The `/vo` command still starts the application correctly.
12. Any pre-existing issues or limitations are explicitly reported.

Run the checks that are actually available in the project. Do not claim a test passed unless you ran it.

## 10. Final report

When finished, report:
- Files changed and why.
- Visual improvements implemented.
- Any new dependencies or assets and their licenses.
- Build and test results.
- Any known limitations.
- The best way to inspect the improvements locally.

Do not stop after producing a plan. Implement the changes in the existing project, verify them, and report the actual results.

Keep the scope limited to visual realism and the existing editor. Do not implement AI agents, authentication, backend services, multiplayer, or the video studio in this milestone.