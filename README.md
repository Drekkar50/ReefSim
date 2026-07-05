# MSG Reef Sim

An individual-based simulation framework for modeling mixed-species group (MSG) dynamics in reef fish, built to explore heterospecific interaction mechanics that sit between population-level marine models (Atlantis, EwE, OSMOSE) and general-purpose ABM platforms (NetLogo, Mesa, Agents.jl).

## Overview

- **2D prototype**: HTML/Canvas proof-of-concept using zonal interaction mechanics (repulsion / orientation / attraction), reef cover patches, heterospecific mixing tendency, and union-find cluster detection.
- **3D extension**: Three.js-based version (in progress).
- **Planned**: behavior-state layer (Schooling / Foraging / Fleeing) driven by utility scoring, with predator agents.

## Motivation

Developed alongside an MS thesis (IISER Mohali / Shanker Lab, IISc Bengaluru) on MSG dynamics in reef fish, drawing on behavioral video datasets from Andaman (fringing reefs) and Lakshadweep (atoll reefs).

## Project structure

```
.
├── sim-2d/          # HTML/Canvas prototype
├── sim-3d/          # Three.js extension
├── docs/            # Notes, diagrams, references
└── README.md
```

## Status

🚧 Active development — 2D prototype working, 3D extension in progress.

## License

MIT (see LICENSE)
