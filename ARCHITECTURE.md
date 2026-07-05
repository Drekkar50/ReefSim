# 3D Mixed-Species Group Simulator — Architecture Guide

This document describes the architecture of a browser-based 3D simulator for
mixed-species groups (MSGs) of reef fish. It is written for **marine biology
researchers** who want to understand, tweak, or extend the simulation — no web
development experience is assumed.

The simulator models how individual fish agents interact through three concentric
behavioral zones (repulsion, orientation, attraction), how reef cover and
predation risk modulate those interactions, and how mixed-species clusters emerge
from simple local rules. All parameters are exposed through sliders in the UI so
you can experiment in real time.

---

## File Structure

| File | Purpose |
|------|---------|
| `index.html` | 3D simulator entry point — defines the **import map** for Three.js module resolution, the control-panel HTML, and bootstraps the app. |
| `js/simulation.js` | Core behavioral model: agent state, zonal forces, stepping logic, reef cover, clustering. All tunable constants live at the top of this file. |
| `js/renderer.js` | Three.js scene setup: camera, lighting, instanced fish meshes, glow effects, reef-cover visualization, and the render loop. |
| `js/ui.js` | Wires the HTML sliders/buttons to `CONFIG`, updates the live metrics panel (group counts, mixing index, etc.). |
| `style.css` | UI styling for the control panel, metrics overlay, and layout. |
| `msg_simulator.html` | Original 2D proof-of-concept (kept for reference; not used by the 3D app). |
| `ARCHITECTURE.md` | This file. |

```
ReefSim/
├── msg_simulator.html      ← original 2D proof-of-concept (kept for reference)
├── index.html               ← 3D simulator entry point
├── js/
│   ├── simulation.js        ← core behavioral model (agents, zones, stepping)
│   ├── renderer.js          ← Three.js scene, meshes, glow, camera
│   └── ui.js                ← control panel bindings, metrics panel updates
├── style.css                ← UI styling
└── ARCHITECTURE.md          ← this file
```

---

## Zonal Interaction Model

This is the heart of the simulation. Every fish agent has **three concentric
zones** around it. At each time-step the agent looks at every other fish and
decides what to do based on which zone the neighbor falls into.

```
                         ·  ·  ·
                    ·                  ·
                ·    Attraction Zone       ·
             ·    (move toward neighbors)     ·
            ·                                   ·
           ·      ·  ·  ·  ·  ·  ·  ·  ·        ·
          ·    ·    Orientation Zone        ·      ·
         ·   ·   (align heading with          ·     ·
         ·  ·     neighbors)                   ·    ·
         · ·                                    ·   ·
         · ·    · · · · · · · · ·               ·   ·
         · ·   · Repulsion Zone  ·              ·   ·
         · ·   · (push away!)   ·               ·   ·
         · ·   ·    ><(((°>     ·               ·   ·
         · ·   · (the fish)     ·               ·   ·
         · ·    · · · · · · · · ·               ·   ·
         ·  ·                                   ·   ·
         ·   ·                                 ·    ·
          ·    ·                             ·      ·
           ·      ·  ·  ·  ·  ·  ·  ·  ·        ·
            ·                                   ·
             ·                                ·
                ·                          ·
                    ·                  ·
                         ·  ·  ·

         |--- RR ---|       = 13 units  (Repulsion)
         |------- RO -------|  = 30 units  (Orientation, base)
         |------------- RA -------------|  = 68 units  (Attraction, base)
```

### Zone 1 — Repulsion (radius `RR = 13`)

If another fish — **of any species** — is within 13 units, push away from it.
This is personal space: species-blind, always active, and strong. It prevents
fish from overlapping.

### Zone 2 — Orientation (base radius `RO_BASE = 30`)

If a neighbor is between 13 and 30 units away, try to align your swimming
direction with theirs.

- If the neighbor is the **same species**, the alignment counts fully (weight 1).
- If the neighbor is a **different species**, the alignment is scaled by the
  `mixing` parameter (a slider from 0 to 1).
  - `mixing = 0`: completely ignore heterospecifics in this zone.
  - `mixing = 1`: treat them exactly like conspecifics.

### Zone 3 — Attraction (base radius `RA_BASE = 68`)

If a neighbor is between 30 and 68 units away, steer toward them. The same
`mixing` weight applies for cross-species neighbors.

### How the zones change dynamically

- **Inside reef cover**: Perception is reduced by up to 65%. All zone radii
  shrink, so fish in dense cover can only "see" nearby neighbors → groups
  become smaller and tighter.
- **Under high predation risk**: The attraction zone expands (see
  [Predation Risk](#predation-risk) below), so fish detect and join groups
  from further away → larger, more cohesive groups (safety in numbers).

### Force weights

The three forces are combined with these weights each time-step:

| Force | Weight | Effect |
|-------|--------|--------|
| Separation (repulsion) | **1.6** | Strongest — preventing collision is top priority |
| Alignment (orientation) | **0.9** | Medium — heading consensus |
| Cohesion (attraction) | **0.045** | Gentle pull — keeps groups together without snapping |

These values were tuned empirically in the 2D prototype (`msg_simulator.html`)
and carried over to the 3D version.

### Where to find these constants

All of the above numbers (`RR`, `RO_BASE`, `RA_BASE`, force weights, etc.) are
defined as named constants at the **top of `simulation.js`**. Search for them
by name to modify.

---

## Reef Cover

Reef cover represents the structural complexity of the reef (corals, rock
overhangs, macroalgae, etc.) that obstructs a fish's line of sight.

### How it is defined

In `simulation.js`, the `COVER_PATCHES` array defines **volumetric cover
regions** — each one is a 3D sphere:

| Property | Meaning |
|----------|---------|
| `center` | A `Vector3` — the (x, y, z) position of the patch center |
| `radius` | How far the cover extends from the center |
| `baseIntensity` | How dense the cover is at the center (0 = none, 1 = maximum) |

### How local cover is computed

The function `coverAt(x, y, z)` calculates the cover intensity at any point:

1. For **each patch**, compute the distance from the query point to the patch
   center.
2. If the point is **inside** the patch radius, contribute:
   ```
   baseIntensity × (1 − distance / radius)
   ```
   This is a **linear falloff** — full intensity at the center, fading to zero
   at the edge.
3. **Sum** all patch contributions (capped at 1.0).
4. **Multiply** by the global `CONFIG.cover` slider value (0–1) so the user can
   scale cover strength globally.

### Effect on fish behavior

Local cover shrinks perception radii:

```
effectiveRadius = baseRadius × (1 − 0.65 × localCover)
```

In dense cover (`localCover ≈ 1`), perception drops to 35% of normal. Fish
can only detect close neighbors → groups become smaller and tighter, which
matches real reef observations.

### Adding a new reef cover region

To add a new patch of cover, open `simulation.js` and add to the
`COVER_PATCHES` array:

```js
// In simulation.js, add to COVER_PATCHES:
COVER_PATCHES.push({
  center: new THREE.Vector3(x, y, z),  // position in world coords
  radius: 180,                          // sphere of influence
  baseIntensity: 0.7                     // how dense the cover is (0-1)
});
```

Replace `x, y, z` with the world-space coordinates where you want the patch.
Increase `radius` for a larger patch; increase `baseIntensity` for denser cover.

---

## Predation Risk

### Current implementation

Predation risk is a **global scalar** controlled by the `CONFIG.risk` slider
(range 0–1). It represents the overall threat level on the reef.

### Effect on behavior

Risk boosts the **attraction zone radius**, making fish seek neighbors from
further away:

```
riskBoost = 1 + 1.6 × CONFIG.risk
effectiveAttractionRadius = RA_BASE × riskBoost × (cover scaling)
```

| Risk | riskBoost | Effective RA (no cover) |
|------|-----------|------------------------|
| 0.0 | 1.0× | 68 |
| 0.5 | 1.8× | 122 |
| 1.0 | 2.6× | 177 |

Higher risk → fish detect groups from further away → they form **larger, more
cohesive aggregations** (safety-in-numbers effect observed in real reef fish).

### Visual indicator

The scene takes on a subtle **reddish ambient tint** proportional to the risk
level, giving the user a visual cue that predation pressure is elevated.

### Planned extension

A future version will replace the single global slider with **localized risk
zones** — spatial patches (implemented like reef cover patches) where predation
risk is elevated in specific areas of the reef. Fish near a risk zone will
tighten up, while fish far from threats will be more relaxed. See
[Planned Future Extensions](#planned-future-extensions).

---

## Clustering & Mixed-Group Detection

The simulator detects **clusters** (groups of fish swimming together) and
identifies which clusters are **mixed-species** (contain two or more species).

### Algorithm

1. **Union-Find (disjoint set)**: a fast data structure that merges fish into
   groups. Every fish starts as its own group.
2. For every pair of agents within `CLUSTER_DIST = 32` units of each other,
   **union** (merge) their groups.
3. After all merges, enumerate the groups:
   - Groups with **fewer than 2 members** are ignored (lone fish).
   - A group is **mixed-species** if it contains agents from **2 or more
     different species**.

### Visual signature

Mixed-species clusters are highlighted with a **pulsing coral-orange glow
sphere** centered on the cluster's centroid. This makes MSGs easy to spot at a
glance.

### Tuning sensitivity

To change how close fish must be to count as "in the same group", adjust
`CLUSTER_DIST` in `simulation.js`:

- **Smaller values** (e.g., 20): stricter — fish must be very close to cluster.
- **Larger values** (e.g., 50): more permissive — loosely associated fish count
  as one group.

---

## Adding a New Species

Adding a species is straightforward:

1. **`simulation.js`** — add entries to two arrays at the top of the file:
   - `SPECIES_COLORS`: add a new CSS hex color string (e.g., `'#FF8800'`).
   - `SPECIES_NAMES`: add the common name (e.g., `'Butterflyfish'`).

2. **`index.html`** — find the species-count slider and increase its `max`
   attribute by one so the UI allows selecting the new species.

3. **That's it.** The simulation loop, renderer (instanced meshes, colors),
   clustering algorithm, and metrics panel will all pick up the new species
   automatically — no other code changes needed.

---

## Extending to Per-Species-Pair Weights

Currently the simulation uses **one global `mixing` parameter** that controls
how much any fish responds to any heterospecific. To model species-specific
affinities (e.g., a wrasse that follows a parrotfish but ignores damselfish),
you can replace the scalar with a **mixing matrix**.

### Step 1 — Define the matrix

In `simulation.js`, replace `CONFIG.mixing` with a 2D array:

```js
CONFIG.mixingMatrix = [
  [1.0, 0.8, 0.3, 0.5, 0.2],  // Damselfish → others
  [0.8, 1.0, 0.6, 0.4, 0.7],  // Wrasse → others
  [0.3, 0.6, 1.0, 0.5, 0.4],  // Parrotfish → others
  [0.5, 0.4, 0.5, 1.0, 0.6],  // Chromis → others
  [0.2, 0.7, 0.4, 0.6, 1.0],  // Cardinalfish → others
];
```

Each row is "how much species _i_ responds to species _j_." The diagonal is
always 1.0 (conspecifics are fully weighted). The matrix can be **asymmetric**
— species A's affinity for B need not equal B's affinity for A.

### Step 2 — Use it in the step function

In the `step()` function, find the line:

```js
const weight = sameSpecies ? 1 : CONFIG.mixing;
```

Replace it with:

```js
const weight = CONFIG.mixingMatrix[a.species][b.species];
```

### Step 3 — Interpret

- **High value** (0.8–1.0): strong affinity — the fish aligns with and is
  attracted to the other species almost as much as its own. Models attendant
  behavior (e.g., a follower species foraging behind a larger species).
- **Low value** (0.0–0.2): weak affinity — the fish mostly ignores the other
  species. Models avoidance or indifference.
- **Asymmetry**: species A might follow species B (high A→B weight) while
  species B ignores A (low B→A weight).

---

## Planned Future Extensions

- **Species-level behavioral traits**: Different speed, zone radii, or force
  weights per species. This would enable attendant/follower dynamics where one
  species benefits from proximity to another — for example, a smaller species
  drafting behind a larger forager.

- **Localized risk zones**: Spatial patches (implemented like reef cover patches)
  where predation risk is elevated, rather than a single global slider. Fish
  near a risk zone would form tighter groups; fish far from threats would
  disperse. This mirrors the spatial heterogeneity of real reefs.

- **Per-species-pair mixing matrix**: As described in the
  [Extending to Per-Species-Pair Weights](#extending-to-per-species-pair-weights)
  section above.

---

## Three.js Concepts (Brief Primer)

If you are unfamiliar with Three.js (the 3D graphics library that powers the
visualization), here is a quick glossary of the concepts used in this project:

| Concept | What it is |
|---------|------------|
| **Scene** | The 3D world container. Every visible object is added to the scene. |
| **Camera** | The viewpoint. We use a `PerspectiveCamera`, which works like a real eye or camera lens — objects further away appear smaller. |
| **Renderer** | Converts the 3D scene into 2D pixels on your screen. We use `WebGLRenderer`, which leverages your GPU for speed. |
| **Mesh** | A visible 3D object, made of a **Geometry** (the shape — e.g., a cone for a fish body) and a **Material** (the appearance — color, shininess, transparency). |
| **InstancedMesh** | A performance optimization for drawing many copies of the same shape. Instead of creating 150 separate meshes for 150 fish, we create **one** `InstancedMesh` and tell the GPU "draw this shape 150 times, at these positions, rotations, and colors." This is vastly faster. |
| **OrbitControls** | A camera controller (imported as a Three.js addon) that lets you interact with the 3D view: **left-drag** to rotate, **scroll** to zoom, **right-drag** to pan. |
| **Vector3** | A 3D vector with components `(x, y, z)`. Used everywhere — positions, velocities, forces, directions. |
| **Import Map** | A `<script type="importmap">` block in `index.html` that tells the browser how to resolve bare module names like `'three'` to actual CDN URLs. This is required because Three.js addon modules (e.g., OrbitControls) internally do `import { ... } from 'three'`, which browsers cannot resolve without an import map. |
| **Emissive Material** | The fish material has an `emissive` property — a self-lit glow that makes species colors vivid regardless of light angle. This ensures fish are always clearly visible against the dark ocean background. |

You do **not** need to understand Three.js internals to adjust simulation
parameters; those are all in `simulation.js`. Three.js knowledge is only
needed if you want to change the visual appearance (colors, shapes, lighting,
effects) in `renderer.js`.

---

## Running the Simulator

The app uses ES modules (`import` / `export`) with an **import map** in
`index.html`. Browsers will only load ES modules over HTTP — opening
`index.html` directly from your file manager (`file://` URL) will **not** work.

### Quickest method (Python, usually pre-installed)

```bash
cd ReefSim/
python3 -m http.server 8000
# Then open http://localhost:8000 in your browser
```

### Alternatives

| Tool | Command |
|------|---------|
| Node.js `serve` | `npx serve .` |
| VS Code extension | Install "Live Server", right-click `index.html` → *Open with Live Server* |
| Any static file server | Point it at the `ReefSim/` directory |

Once the page loads you should see the 3D reef environment with fish swimming.
Use the control panel on the left to adjust species counts, mixing, cover, and
risk in real time.

### Troubleshooting

- **Blank viewport / no fish**: Open your browser's developer console (F12 →
  Console tab). If you see `Failed to resolve module specifier "three"`, the
  import map in `index.html` is not being loaded — make sure you are serving
  via HTTP, not opening the file directly.
- **Fish visible but very dim**: The scene uses emissive materials and multiple
  lights. If something looks off, check `renderer.js` lighting section
  (search for `LIGHTING`).
