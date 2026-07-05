/**
 * ============================================================================
 * simulation.js — CORE BEHAVIORAL MODEL
 * ============================================================================
 *
 * This file is the heart of the 3D reef fish mixed-species group simulator.
 * It implements a **zonal interaction model** inspired by the classic
 * Couzin et al. (2002) framework, extended with:
 *
 *   • Species-specific social weighting (mixing parameter)
 *   • Environmental reef cover that modulates perception range
 *   • Predation risk that expands the attraction zone (tighter schooling)
 *
 * The model divides the space around each fish into three concentric zones:
 *
 *   1. REPULSION ZONE (0 → RR)
 *      The innermost zone — personal space. Any neighbor inside this zone
 *      causes the focal fish to steer AWAY, regardless of species. This
 *      prevents collisions and maintains minimum inter-individual distance.
 *
 *   2. ORIENTATION ZONE (RR → RO)
 *      The middle zone. The focal fish aligns its heading (velocity) with
 *      neighbors in this zone. Alignment strength is weighted by a mixing
 *      coefficient: conspecifics (same species) get full weight, while
 *      heterospecifics get reduced weight proportional to CONFIG.mixing.
 *
 *   3. ATTRACTION ZONE (RO → RA)
 *      The outermost zone. The focal fish steers TOWARD the average
 *      position of neighbors in this zone. This produces cohesion —
 *      the tendency for fish to aggregate into schools. Like orientation,
 *      attraction is species-weighted via the mixing parameter.
 *
 * The three zones produce emergent collective behavior: repulsion prevents
 * crowding, orientation creates polarized schools, and attraction keeps
 * the group together. Adjusting the zone radii and weights changes the
 * structure from loose shoals to tight polarized schools.
 *
 * All simulation logic is PURE — no rendering, no DOM access, no side
 * effects beyond updating the agents array. Rendering is handled by
 * separate modules.
 *
 * ============================================================================
 */

import * as THREE from 'three';


// ============================================================================
// CONSTANTS — Fundamental model parameters
// ============================================================================

/**
 * Color palette for each species, chosen for high contrast on dark
 * underwater backgrounds. Up to 5 species are supported.
 */
export const SPECIES_COLORS = ['#4FD1C5', '#F2B84B', '#E85D9E', '#9BD86E', '#62A7E0'];

/**
 * Human-readable species names corresponding to each color index.
 * These represent common reef fish families with differing social
 * tendencies — from the highly social Damselfish to the loosely
 * aggregating Surgeonfish.
 */
export const SPECIES_NAMES = ['Damselfish', 'Wrasse', 'Goatfish', 'Snapper', 'Surgeonfish'];

/**
 * RR — Repulsion Radius (body lengths, roughly 13 units)
 *
 * This defines the "personal space" around each fish. ANY neighbor
 * closer than RR triggers avoidance, regardless of species identity.
 * Biologically, this corresponds to the minimum distance fish maintain
 * to avoid hydrodynamic interference and physical collision.
 *
 * This zone is SPECIES-BLIND: even heterospecifics cause repulsion.
 */
export const RR = 13;

/**
 * RO_BASE — Orientation Zone base radius
 *
 * Neighbors between RR and RO contribute to alignment steering.
 * The actual radius is modulated by local reef cover (dense cover
 * reduces perception range, simulating visual occlusion by coral).
 */
export const RO_BASE = 30;

/**
 * RA_BASE — Attraction Zone base radius
 *
 * Neighbors between RO and RA contribute to cohesion steering.
 * This is the outermost zone — fish beyond RA are not perceived.
 * This radius is modulated by both cover AND risk: higher risk
 * expands RA, causing fish to school more tightly (a well-documented
 * anti-predator response in reef fishes).
 */
export const RA_BASE = 68;

/**
 * MAX_SPEED — Maximum swimming speed (units/step)
 *
 * Caps the magnitude of each agent's velocity vector. Prevents
 * unrealistically fast movement when strong steering forces accumulate.
 * Tuned down from 2.1 to 1.0 for visual clarity.
 */
export const MAX_SPEED = 1.0;

/**
 * MAX_FORCE — Maximum steering force per step
 *
 * Limits how quickly a fish can change direction. Lower values
 * produce smoother, more realistic turning. Higher values allow
 * abrupt direction changes (more "reactive" behavior).
 */
export const MAX_FORCE = 0.09;

/**
 * CLUSTER_DIST — Distance threshold for union-find clustering
 *
 * Two fish within this distance are considered part of the same
 * social group/cluster. Used to identify coherent sub-groups
 * (schools, shoals) in the population for analysis and display.
 */
export const CLUSTER_DIST = 32;

/**
 * WORLD_SIZE — Half-extent of the cubic simulation volume
 *
 * The simulation volume spans from -WORLD_SIZE to +WORLD_SIZE on
 * each axis, giving a total volume of (2*WORLD_SIZE)³ = 800³ units.
 * In Three.js, Y is the vertical axis.
 */
export const WORLD_SIZE = 400;


// ============================================================================
// CONFIG — Mutable simulation parameters (adjusted via UI)
// ============================================================================

/**
 * CONFIG holds all user-adjustable parameters. These can be changed
 * at runtime via the GUI panel without restarting the simulation.
 *
 * speciesCount:          Number of species present (1–5)
 * individualsPerSpecies: Number of fish per species
 * mixing:               Heterospecific interaction weight (0 = ignore
 *                        other species entirely, 1 = treat them
 *                        identically to conspecifics)
 * cover:                Overall reef structural complexity (0 = open
 *                        water, 1 = dense coral). Modulates perception
 *                        ranges via COVER_PATCHES.
 * risk:                 Perceived predation risk (0 = safe, 1 = high
 *                        danger). Higher risk expands attraction zones,
 *                        producing tighter, more cohesive schools.
 */
export const CONFIG = {
    speciesCount: 3,
    individualsPerSpecies: 14,
    mixing: 0.5,
    cover: 0.45,
    risk: 0.3,
    worldSizeX: 400,
    worldSizeY: 400,
    worldSizeZ: 400
};


// ============================================================================
// COVER_PATCHES — 3D reef structural complexity regions
// ============================================================================

/**
 * Reef cover patches simulate the spatial distribution of coral
 * structures across the simulation volume. Each patch represents
 * a region of reef with a certain structural complexity.
 *
 * In real reef environments, structural complexity (rugosity) varies
 * spatially. Dense branching coral provides visual cover, reducing
 * how far fish can see. This in turn shrinks their interaction zones,
 * leading to smaller, more fragmented groups near reef structure
 * versus large, cohesive schools over open sand.
 *
 * Each patch is defined by:
 *   center:        3D position of the patch's core (Vector3)
 *   radius:        Sphere of influence — how far the cover extends
 *   baseIntensity: How dense the cover is at the center (0–1)
 *
 * Cover intensity falls off linearly from the center to the edge.
 *
 * Spatial layout rationale:
 *   - Patches are spread across the volume to create heterogeneous
 *     habitat. Some are near the bottom (Y < 0) simulating reef
 *     floor bommies; others are mid-water representing coral heads
 *     that rise from the substrate.
 *   - Radii are scaled proportionally from the 2D version:
 *     original 2D space was ~640×560 with radii 80–140;
 *     our 3D space is 800³, so radii scale to ~120–250.
 */
export const COVER_PATCHES = [
    // Large reef bommie near the substrate floor, left-front quadrant
    {
        center: new THREE.Vector3(-180, -220, -120),
        radius: 240,
        baseIntensity: 0.85
    },

    // Tall coral head rising from the floor, right-back quadrant
    {
        center: new THREE.Vector3(200, -150, 180),
        radius: 200,
        baseIntensity: 0.75
    },

    // Mid-water reef structure, central area (e.g., a pinnacle)
    {
        center: new THREE.Vector3(30, -40, -60),
        radius: 180,
        baseIntensity: 0.65
    },

    // Smaller patch near the surface, back-left — perhaps a shallow reef flat
    {
        center: new THREE.Vector3(-250, 100, 200),
        radius: 150,
        baseIntensity: 0.55
    },

    // Deep reef patch, far-right bottom corner
    {
        center: new THREE.Vector3(280, -300, -250),
        radius: 220,
        baseIntensity: 0.70
    },

    // Scattered rubble zone, mid-depth, near center-right
    {
        center: new THREE.Vector3(140, -80, 50),
        radius: 130,
        baseIntensity: 0.50
    }
];


// ============================================================================
// coverAt(x, y, z) — Local reef cover intensity at a 3D point
// ============================================================================

/**
 * Computes the effective reef cover intensity at a given 3D position.
 *
 * The function sums contributions from ALL cover patches. Each patch
 * contributes its baseIntensity scaled by a linear falloff:
 *
 *   contribution = baseIntensity × (1 - distance / radius)
 *
 * This means cover is strongest at the patch center and fades to zero
 * at the patch edge. Overlapping patches stack additively (a point
 * inside two patches receives cover from both).
 *
 * The raw sum is clamped to [0, 1] and then multiplied by CONFIG.cover,
 * which acts as a global "reef density" slider. When CONFIG.cover = 0,
 * the entire environment is open water. When CONFIG.cover = 1, patches
 * have full effect.
 *
 * @param {number} x — X coordinate in world space
 * @param {number} y — Y coordinate in world space (vertical in Three.js)
 * @param {number} z — Z coordinate in world space
 * @returns {number} Cover intensity in [0, CONFIG.cover], used to
 *                    scale perception zones.
 */

// Pre-allocated Vector3 for cover distance calculations (avoid GC churn)
const _coverPoint = new THREE.Vector3();

export function coverAt(x, y, z) {
    _coverPoint.set(x, y, z);
    let sum = 0;

    for (let i = 0; i < COVER_PATCHES.length; i++) {
        const patch = COVER_PATCHES[i];
        const dist = _coverPoint.distanceTo(patch.center);

        if (dist < patch.radius) {
            // Linear falloff: full intensity at center, zero at edge
            sum += patch.baseIntensity * (1 - dist / patch.radius);
        }
    }

    // Clamp raw sum to [0, 1], then scale by global cover parameter
    if (sum > 1) sum = 1;
    return sum * CONFIG.cover;
}


// ============================================================================
// RISK_PATCHES — 3D spatially heterogeneous predation risk zones
// ============================================================================

/**
 * Predation risk patches simulate the spatial distribution of predation
 * pressure across the simulation volume. Each patch represents a zone
 * where predation risk is elevated due to environmental or ecological
 * factors (e.g., ambush points, exposed areas, predator territories).
 *
 * In real reef environments, predation risk is not uniform — certain
 * microhabitats are more dangerous than others. Reef edges attract
 * ambush predators, open sand channels expose fish to pelagic hunters,
 * crevice entrances harbor moray eels, and shallow reef crests leave
 * fish vulnerable to aerial predators (e.g., seabirds).
 *
 * Each patch is defined by:
 *   center:        3D position of the patch's core (Vector3)
 *   radius:        Sphere of influence — how far the risk extends
 *   baseIntensity: How dangerous the zone is at the center (0–1)
 *
 * Risk intensity falls off linearly from the center to the edge.
 */
export const RISK_PATCHES = [
    // Ambush zone near a reef edge, lower-left
    {
        center: new THREE.Vector3(-200, -100, 200),
        radius: 200,
        baseIntensity: 0.9
    },
    // Open sand channel — exposed to pelagic predators
    {
        center: new THREE.Vector3(250, 50, -150),
        radius: 250,
        baseIntensity: 0.75
    },
    // Crevice entrance where moray eels lurk
    {
        center: new THREE.Vector3(50, -250, -50),
        radius: 160,
        baseIntensity: 0.85
    },
    // Shallow reef crest — exposed to aerial predators
    {
        center: new THREE.Vector3(-100, 200, 100),
        radius: 180,
        baseIntensity: 0.65
    }
];


// ============================================================================
// riskAt(x, y, z) — Local predation risk intensity at a 3D point
// ============================================================================

/**
 * Computes the effective predation risk at a given 3D position.
 *
 * Models spatially heterogeneous predation risk across the reef
 * environment. The function sums contributions from ALL risk patches,
 * each contributing its baseIntensity scaled by a linear falloff:
 *
 *   contribution = baseIntensity × (1 - distance / radius)
 *
 * Risk is strongest at the patch center and fades to zero at the edge.
 * Overlapping patches stack additively. The raw sum is clamped to [0, 1]
 * and then multiplied by CONFIG.risk, which acts as a global risk slider.
 *
 * @param {number} x — X coordinate in world space
 * @param {number} y — Y coordinate in world space (vertical in Three.js)
 * @param {number} z — Z coordinate in world space
 * @returns {number} Risk intensity in [0, CONFIG.risk], used to
 *                    scale attraction zones for anti-predator schooling.
 */

// Pre-allocated Vector3 for risk distance calculations (avoid GC churn)
const _riskPoint = new THREE.Vector3();

export function riskAt(x, y, z) {
    _riskPoint.set(x, y, z);
    let sum = 0;
    for (let i = 0; i < RISK_PATCHES.length; i++) {
        const patch = RISK_PATCHES[i];
        const dist = _riskPoint.distanceTo(patch.center);
        if (dist < patch.radius) {
            sum += patch.baseIntensity * (1 - dist / patch.radius);
        }
    }
    if (sum > 1) sum = 1;
    return sum * CONFIG.risk;
}


// ============================================================================
// agents[] — The population
// ============================================================================

/**
 * The global array of all fish agents. Each agent is a plain object:
 *
 *   {
 *     species:  integer (0-based species index),
 *     position: THREE.Vector3 — current 3D position,
 *     velocity: THREE.Vector3 — current 3D velocity (heading + speed)
 *   }
 *
 * Agents are re-created by initAgents() and updated in-place by step().
 */
export const agents = [];


// ============================================================================
// initAgents() — Initialize / reset the population
// ============================================================================

/**
 * Clears the agents array and populates it with fresh fish.
 *
 * Each species gets CONFIG.individualsPerSpecies fish. Initial positions
 * are uniformly random within the simulation volume (with a 40-unit
 * margin from the walls to prevent immediate boundary bouncing).
 * Initial velocities are small random vectors, giving each fish a
 * random heading at spawn.
 *
 * Call this whenever CONFIG.speciesCount or CONFIG.individualsPerSpecies
 * changes, or to fully reset the simulation.
 */
export function initAgents() {
    // Clear existing agents (preserve the array reference so external
    // code holding a reference to `agents` still works)
    agents.length = 0;

    const margin = 40; // Keep spawns away from boundary walls
    const loX = -CONFIG.worldSizeX + margin;
    const hiX =  CONFIG.worldSizeX - margin;
    const loY = -CONFIG.worldSizeY + margin;
    const hiY =  CONFIG.worldSizeY - margin;
    const loZ = -CONFIG.worldSizeZ + margin;
    const hiZ =  CONFIG.worldSizeZ - margin;

    for (let s = 0; s < CONFIG.speciesCount; s++) {
        for (let i = 0; i < CONFIG.individualsPerSpecies; i++) {
            agents.push({
                species: s,

                // Random position within the volume, avoiding edges
                position: new THREE.Vector3(
                    loX + Math.random() * (hiX - loX),
                    loY + Math.random() * (hiY - loY),
                    loZ + Math.random() * (hiZ - loZ)
                ),

                // Small random initial velocity — gives a random heading
                // without excessive initial speed
                velocity: new THREE.Vector3(
                    (Math.random() - 0.5) * 2,  // range [-1, 1]
                    (Math.random() - 0.5) * 2,
                    (Math.random() - 0.5) * 2
                )
            });
        }
    }
}


// ============================================================================
// step() — Advance the simulation by one time step (THE HOT LOOP)
// ============================================================================

/**
 * PRE-ALLOCATED TEMPORARY VECTORS
 *
 * These are reused every frame to avoid creating new objects inside
 * the O(N²) inner loop. Garbage collection pauses from Vector3
 * allocations would cause visible stuttering at high agent counts.
 *
 * Naming convention:  _purpose
 *   _delta:     Vector from agent A to agent B
 *   _sep:       Accumulated separation (repulsion) steering
 *   _ali:       Accumulated alignment steering
 *   _coh:       Accumulated cohesion steering
 *   _steer:     Combined steering force
 *   _normDelta: Normalized direction vector (reusable scratch)
 */
const _delta = new THREE.Vector3();
const _sep = new THREE.Vector3();
const _ali = new THREE.Vector3();
const _coh = new THREE.Vector3();
const _steer = new THREE.Vector3();
const _normDelta = new THREE.Vector3();

/**
 * step() — The main simulation update.
 *
 * Iterates over all agents, computes zonal steering forces from
 * pairwise interactions, applies forces to velocity, updates
 * positions, and handles boundary conditions.
 *
 * Computational complexity: O(N²) where N = total agent count.
 * For typical reef simulations (N < 100), this runs comfortably
 * at 60 fps. For larger populations, spatial hashing could be
 * added, but simplicity is prioritized here.
 */
export function step() {
    const n = agents.length;

    // ----------------------------------------------------------------
    // Risk boost is computed PER AGENT using local predation risk
    // from riskAt(). See the per-agent section below.
    // ----------------------------------------------------------------

    for (let i = 0; i < n; i++) {
        const a = agents[i];

        // Reset accumulators to zero (reuse pre-allocated vectors)
        _sep.set(0, 0, 0);
        _ali.set(0, 0, 0);
        _coh.set(0, 0, 0);
        let sepCount = 0;
        let aliCount = 0;
        let cohCount = 0;

        // --------------------------------------------------------------
        // LOCAL COVER PERCEPTION
        //
        // Reef cover reduces how far a fish can see. Dense coral acts
        // as a visual barrier, shrinking the orientation and attraction
        // zones. The repulsion zone (RR) is NOT affected — collision
        // avoidance works at close range regardless of visibility.
        //
        // perceptionScale ranges from 1.0 (open water, full perception)
        // to 0.35 (maximum cover, heavily reduced perception).
        //
        // The 0.65 multiplier means at most 65% of the base perception
        // range is lost in the densest cover. This prevents zones from
        // collapsing to zero, which would make fish unresponsive.
        // --------------------------------------------------------------
        const localCover = coverAt(a.position.x, a.position.y, a.position.z);
        const perceptionScale = 1 - 0.65 * localCover;
        const localRisk = riskAt(a.position.x, a.position.y, a.position.z);
        const riskBoost = 1 + 1.6 * localRisk;
        const ro = RO_BASE * perceptionScale;
        const ra = RA_BASE * perceptionScale * riskBoost;

        // --------------------------------------------------------------
        // PAIRWISE INTERACTION LOOP
        //
        // For each other agent, determine which zone it falls in and
        // accumulate the appropriate steering contribution.
        // --------------------------------------------------------------
        for (let j = 0; j < n; j++) {
            if (i === j) continue;

            const b = agents[j];

            // Compute displacement vector from A to B
            _delta.subVectors(b.position, a.position);
            const d = _delta.length();

            // Skip if overlapping (d=0) or beyond perception range
            if (d === 0 || d > ra) continue;

            // ----------------------------------------------------------
            // SPECIES-DEPENDENT WEIGHTING
            //
            // Conspecifics (same species) always have weight 1.0.
            // Heterospecifics are weighted by CONFIG.mixing:
            //   mixing = 0: ignore other species (species-segregated)
            //   mixing = 1: treat all species equally (fully mixed)
            //   mixing = 0.5: half-weight for other species (partial mixing)
            //
            // This is the key parameter for studying mixed-species
            // group formation — it controls the degree of interspecific
            // social attraction.
            //
            // NOTE: Repulsion (collision avoidance) is always species-blind
            // with weight 1.0 — fish avoid collisions with everyone.
            // ----------------------------------------------------------
            const sameSpecies = b.species === a.species;
            const weight = sameSpecies ? 1 : CONFIG.mixing;

            if (d < RR) {
                // ==============================================================
                // ZONE 1: REPULSION (0 → RR)
                //
                // Push AWAY from the neighbor. The steering direction is the
                // negative of the normalized delta (pointing from B back to A).
                //
                // This is SPECIES-BLIND: all neighbors in the repulsion zone
                // contribute equally to avoidance. Even heterospecifics that
                // would be ignored for alignment/cohesion still trigger
                // collision avoidance.
                //
                // Each repulsive neighbor contributes a unit vector pointing
                // away. After the loop, we average these and scale by a strong
                // weight (1.6) to make repulsion dominant at close range.
                // ==============================================================
                _normDelta.copy(_delta).normalize();
                _sep.sub(_normDelta);  // Subtract = push away (opposite direction)
                sepCount++;

            } else if (d < ro) {
                // ==============================================================
                // ZONE 2: ORIENTATION (RR → RO)
                //
                // Align heading with the neighbor's velocity. The focal fish
                // tries to match the direction and speed of nearby fish.
                //
                // This is what produces POLARIZED schools — all fish facing
                // the same way. Without this zone, groups would form but
                // individuals would face random directions (a "shoal" rather
                // than a "school").
                //
                // Each neighbor's velocity is added, weighted by species
                // affinity. Conspecifics contribute fully; heterospecifics
                // contribute proportionally to the mixing parameter.
                // ==============================================================
                _ali.addScaledVector(b.velocity, weight);
                aliCount += weight;

            } else {
                // ==============================================================
                // ZONE 3: ATTRACTION (RO → RA)
                //
                // Steer TOWARD the neighbor. The delta vector already points
                // from A to B, which is the direction A should move to get
                // closer to B.
                //
                // This is what holds the group together. Without attraction,
                // fish would drift apart after initial encounters. The
                // attraction zone is the largest, allowing fish to perceive
                // and join groups from a distance.
                //
                // The attraction zone expands with predation risk (riskBoost),
                // modeling the empirical observation that fish form tighter,
                // larger groups when predators are present.
                // ==============================================================
                _coh.addScaledVector(_delta, weight);
                cohCount += weight;
            }
        }

        // ==================================================================
        // STEERING FORCE COMPUTATION
        //
        // Combine the three zone-based forces with empirically tuned weights:
        //
        //   Separation weight: 1.6  (strongest — collision avoidance is critical)
        //   Alignment weight:  0.9  (moderate — produces schooling)
        //   Cohesion weight:   0.045 (weakest — long-range but gentle pull)
        //
        // These weights produce the characteristic "schooling" behavior:
        // tight enough to stay together, loose enough to not clump into a
        // single point, and polarized enough to move coherently.
        //
        // Each force is averaged (divided by count) before scaling, so
        // the force magnitude is independent of neighbor count. This
        // prevents steering from becoming overwhelming in dense groups.
        // ==================================================================
        _steer.set(0, 0, 0);

        if (sepCount > 0) {
            // Average the separation vectors and apply strong weight
            _steer.addScaledVector(_sep, 1.6 / sepCount);
        }

        if (aliCount > 0) {
            // Average the alignment vectors and apply moderate weight
            _steer.addScaledVector(_ali, 0.9 / aliCount);
        }

        if (cohCount > 0) {
            // Average the cohesion vectors and apply gentle weight
            _steer.addScaledVector(_coh, 0.045 / cohCount);
        }

        // ==================================================================
        // 3D WANDER NOISE
        //
        // A small random perturbation on each axis prevents agents from
        // settling into perfectly static formations. In real fish schools,
        // individuals constantly make small course corrections. This noise
        // keeps the simulation lively and prevents degenerate equilibria
        // (e.g., all fish converging to a single point and stopping).
        //
        // The noise magnitude (±0.06) is small enough to not disrupt
        // schooling but large enough to prevent lock-in.
        // ==================================================================
        _steer.x += (Math.random() - 0.5) * 0.12;  // range: -0.06 to +0.06
        _steer.y += (Math.random() - 0.5) * 0.12;
        _steer.z += (Math.random() - 0.5) * 0.12;

        // ==================================================================
        // FORCE CLAMPING
        //
        // Limit the steering force magnitude to MAX_FORCE. This ensures
        // fish turn gradually rather than making instantaneous direction
        // changes. It models the physical constraint of body flexibility
        // and hydrodynamic turning radius.
        // ==================================================================
        const steerMag = _steer.length();
        if (steerMag > MAX_FORCE) {
            _steer.multiplyScalar(MAX_FORCE / steerMag);
        }

        // ==================================================================
        // VELOCITY UPDATE
        //
        // Apply the steering force to the velocity (F = ma with m = 1),
        // then clamp speed to MAX_SPEED.
        //
        // The minimum speed check (< 0.4) gives a small boost to nearly-
        // stationary fish. Real fish rarely stop swimming completely —
        // they need forward motion to breathe (ram ventilation in many
        // reef species) and to maintain stability. The 1.05 multiplier
        // gently accelerates stalled fish without being jarring.
        // ==================================================================
        a.velocity.add(_steer);

        const speed = a.velocity.length();
        if (speed > MAX_SPEED) {
            a.velocity.multiplyScalar(MAX_SPEED / speed);
        } else if (speed < 0.4) {
            // Boost nearly-stopped fish to prevent stalling
            a.velocity.multiplyScalar(1.05);
        }

        // ==================================================================
        // POSITION UPDATE
        //
        // Simple Euler integration: position += velocity × dt (dt = 1)
        // ==================================================================
        a.position.add(a.velocity);

        // ==================================================================
        // BOUNDARY CONDITIONS — Elastic bounce on all 6 faces
        //
        // When a fish reaches the edge of the simulation volume, it
        // bounces back inward. The velocity component perpendicular to
        // the wall is flipped, simulating an elastic reflection.
        //
        // A margin of 16 units provides a soft boundary zone. The
        // position is clamped to prevent fish from escaping during
        // large time steps.
        //
        // In the context of the simulation, this represents the
        // boundaries of the reef habitat — fish don't swim off into
        // the open ocean.
        // ==================================================================
        const margin = 16;
        const loX = -CONFIG.worldSizeX + margin;
        const hiX =  CONFIG.worldSizeX - margin;
        const loY = -CONFIG.worldSizeY + margin;
        const hiY =  CONFIG.worldSizeY - margin;
        const loZ = -CONFIG.worldSizeZ + margin;
        const hiZ =  CONFIG.worldSizeZ - margin;

        // X axis boundaries (left/right walls)
        if (a.position.x < loX) {
            a.position.x = loX;
            a.velocity.x = Math.abs(a.velocity.x);  // Flip to positive (inward)
        } else if (a.position.x > hiX) {
            a.position.x = hiX;
            a.velocity.x = -Math.abs(a.velocity.x); // Flip to negative (inward)
        }

        // Y axis boundaries (floor/ceiling — vertical in Three.js)
        if (a.position.y < loY) {
            a.position.y = loY;
            a.velocity.y = Math.abs(a.velocity.y);
        } else if (a.position.y > hiY) {
            a.position.y = hiY;
            a.velocity.y = -Math.abs(a.velocity.y);
        }

        // Z axis boundaries (front/back walls)
        if (a.position.z < loZ) {
            a.position.z = loZ;
            a.velocity.z = Math.abs(a.velocity.z);
        } else if (a.position.z > hiZ) {
            a.position.z = hiZ;
            a.velocity.z = -Math.abs(a.velocity.z);
        }
    }
}


// ============================================================================
// findClusters() — Union-find based group detection
// ============================================================================

/**
 * Identifies coherent social groups (clusters) among the agents using
 * a union-find (disjoint set) data structure.
 *
 * Two fish are considered part of the same cluster if they are within
 * CLUSTER_DIST of each other. The union-find merges overlapping pairs
 * transitively — if A is near B and B is near C, then A, B, and C are
 * all in the same cluster even if A and C are far apart.
 *
 * This is useful for:
 *   • Counting the number of distinct groups (schools/shoals)
 *   • Measuring group sizes for behavioral analysis
 *   • Identifying mixed-species groups vs. single-species schools
 *   • Coloring or labeling groups in the 3D visualization
 *
 * Only groups of size ≥ 2 are returned (isolated fish are not clusters).
 *
 * Algorithm complexity: O(N²) for pairwise distance checks, with
 * near-O(N) union-find operations via path compression.
 *
 * @returns {Array<Array<Object>>} Array of clusters, where each cluster
 *          is an array of agent objects. Sorted by cluster size (largest
 *          first) implicitly by discovery order.
 */
export function findClusters() {
    const n = agents.length;
    if (n === 0) return [];

    // ------------------------------------------------------------------
    // UNION-FIND DATA STRUCTURE
    //
    // parent[i] stores the parent of node i. Initially, each node is
    // its own parent (each fish is in its own singleton set).
    //
    // find(i) returns the root representative of i's set, with path
    // compression (path halving) for amortized near-constant time.
    //
    // union(i, j) merges the sets containing i and j.
    // ------------------------------------------------------------------
    const parent = Array.from({ length: n }, (_, i) => i);

    /**
     * Find with path compression (path halving variant).
     * Each call flattens two levels of the tree, keeping
     * amortized time nearly O(1) per operation.
     */
    function find(i) {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]]; // Path halving
            i = parent[i];
        }
        return i;
    }

    /**
     * Union: merge the sets containing i and j.
     * Simple union (no rank), sufficient for our population sizes.
     */
    function union(i, j) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) {
            parent[ri] = rj;
        }
    }

    // ------------------------------------------------------------------
    // PAIRWISE DISTANCE CHECKS
    //
    // For each pair of agents, if their 3D Euclidean distance is less
    // than CLUSTER_DIST, they are merged into the same cluster.
    //
    // This is the O(N²) bottleneck. For N < 100, it's negligible.
    // ------------------------------------------------------------------
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dist = agents[i].position.distanceTo(agents[j].position);
            if (dist < CLUSTER_DIST) {
                union(i, j);
            }
        }
    }

    // ------------------------------------------------------------------
    // GROUP EXTRACTION
    //
    // Collect agents into groups by their root representative.
    // Use a Map keyed by root index for efficient grouping.
    // ------------------------------------------------------------------
    const groups = new Map();

    for (let i = 0; i < n; i++) {
        const root = find(i);
        if (!groups.has(root)) {
            groups.set(root, []);
        }
        groups.get(root).push(agents[i]);
    }

    // Return only groups with 2+ members (exclude isolated individuals)
    const clusters = [];
    for (const group of groups.values()) {
        if (group.length >= 2) {
            clusters.push(group);
        }
    }

    return clusters;
}
