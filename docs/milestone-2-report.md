# Milestone 2 — Realistic Office Builder: Final Report

## Performance (Stage D)

Measured with the `?stats` overlay on the default layout, using a separate origin (`127.0.0.1:5173`) so no saved layout was involved.
Machine: Apple M2, Chrome 155, canvas at device pixel ratio 2 (capped at 1.7 by the app), viewport 1710 × 985.

- **Draw calls and triangles** are totals for a whole frame: shadow map pass, contact shadows and main pass.
- **CPU** is the main-thread time spent inside `renderer.render` per frame (mean over one second).
- **FPS** is capped at 60 by the display in every case on this machine, so CPU time and frames rendered while idle are the numbers to compare.
- **CPU time is noisy on this laptop** (the same build measured 3.1 ms in one run and 7.5 ms in another), so CPU comparisons come from back-to-back A/B runs, not from separate sessions.

| Scenario | Before (Stage C) | After Task 2 (merged rooms) | After Task 3 (render on demand) |
|---|---|---|---|
| 3D overview, idle | 60 fps · 3.1 ms · 1305 calls · 112,734 tris | 60 fps · 803 calls · 112,734 tris; back-to-back A/B: 7.5 ms → 5.3 ms | idle: no frames rendered |
| 3D overview, orbiting | 60 fps · 3.0 ms · 1305 calls | 60 fps · 749–803 calls | 60 fps while the camera moves (including damping), then 0 · 2.1–2.3 ms · 751–803 calls |
| 3D edit mode, dragging a desk | 60 fps · 2.9 ms · 1305–1346 calls | 803–805 calls in edit mode with a selection (drag not re-measured) | one frame per pointer move · 3.4 ms · 844 calls (the automated drag sends ~5 moves a second, so its fps shows the input rate, not a limit) |
| Floor plan, idle | 60 fps · 2.4 ms · 171 calls · 1,466 tris | 60 fps · 171 calls (unchanged: floor plan draws no walls) | idle: no frames rendered |
| Frames rendered per second while nothing changes | 60 | 60 | **0** |

With render on demand, each of these repaints immediately without moving the mouse (checked in the browser): orbit, zoom, switching between 3D and floor plan, Reset view, hover highlight, select, dragging furniture and rooms, resize handles, undo/redo shortcuts, confirming Reset layout, and resizing the browser window. Room labels follow the camera.
