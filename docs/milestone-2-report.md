# Milestone 2 — Realistic Office Builder: Final Report

## Performance (Stage D)

Measured with the `?stats` overlay on the default layout, using a separate origin (`127.0.0.1:5173`) so no saved layout was involved.
Machine: Apple M2, Chrome 155, canvas at device pixel ratio 2 (capped at 1.7 by the app), viewport 1710 × 985.

- **Draw calls and triangles** are totals for a whole frame: shadow map pass, contact shadows and main pass.
- **CPU** is the main-thread time spent inside `renderer.render` per frame (mean over one second).
- **FPS** is capped at 60 by the display in every case on this machine, so CPU time and frames rendered while idle are the numbers to compare.

| Scenario | Before (Stage C) | After Task 2 (merged rooms) | After Task 3 (render on demand) |
|---|---|---|---|
| 3D overview, idle | 60 fps · 3.1 ms · 1305 calls · 112,734 tris | | |
| 3D overview, orbiting | 60 fps · 3.0 ms · 1305 calls | | |
| 3D edit mode, dragging a desk | 60 fps · 2.9 ms · 1305–1346 calls | | |
| Floor plan, idle | 60 fps · 2.4 ms · 171 calls · 1,466 tris | | |
| Frames rendered per second while nothing changes | 60 | | |
