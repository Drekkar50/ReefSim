/**
 * ============================================================================
 * renderer.js — Three.js 3D Rendering Layer
 * ============================================================================
 *
 * Handles all visual output for the reef fish simulator:
 *
 *   • Scene setup (lighting, background, fog)
 *   • Fish rendering via InstancedMesh (one draw call for all fish)
 *   • Reef cover patches as translucent green spheres
 *   • Mixed-species group glow (pulsing coral-orange spheres)
 *   • Bounding box wireframe showing the simulation volume
 *   • Predation risk ambient tinting
 *   • OrbitControls for interactive camera
 *
 * This module is PURE RENDERING — it reads simulation state from
 * simulation.js but never modifies it.
 *
 * ============================================================================
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
    agents, CONFIG, COVER_PATCHES, RISK_PATCHES, SPECIES_COLORS,
    WORLD_SIZE, findClusters
} from './simulation.js';


// ============================================================================
// MODULE STATE
// ============================================================================

let scene, camera, renderer, controls;
let fishMesh;           // InstancedMesh for all fish
let coverMeshes = [];   // Array of translucent sphere meshes for reef cover
let glowMeshes = [];    // Pool of glow sphere meshes for mixed-group halos
let boundingBoxLine;    // Wireframe bounding box
let riskLight;          // Hemisphere light for risk tinting
let riskMeshes = [];    // Array of translucent red sphere meshes for risk zones
let clock;              // Three.js clock for animation timing

// Pre-allocated objects for the per-frame update loop
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _lookTarget = new THREE.Vector3();
const _color = new THREE.Color();
const _centroid = new THREE.Vector3();

// Fish geometry scale — small enough to look proportional in the 3D volume.
// Reduced to roughly one-third of the original size so the fish read as
// compact darting shapes rather than oversized cones.
const FISH_LENGTH = 7;
const FISH_WIDTH = 3.5;

// Maximum number of glow meshes in the pool
const MAX_GLOW_MESHES = 30;

// Maximum expected agent count (for InstancedMesh pre-allocation)
const MAX_AGENTS = 200;


// ============================================================================
// init() — Create the Three.js scene and all visual elements
// ============================================================================

/**
 * Initializes the entire rendering pipeline.
 *
 * @param {HTMLElement} container — DOM element to mount the canvas into
 * @returns {void}
 */
export function init(container) {
    clock = new THREE.Clock();

    // ------------------------------------------------------------------
    // SCENE — The 3D world container
    // ------------------------------------------------------------------
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#081720');

    // Light distance fog for depth cues — reduced density so fish
    // stay visible even at the far side of the volume
    scene.fog = new THREE.FogExp2('#081720', 0.0003);

    // ------------------------------------------------------------------
    // CAMERA — Perspective view into the scene
    //
    // FOV 55° gives a natural field of view for underwater scenes.
    // Near/far clipping planes span the simulation volume with margin.
    // ------------------------------------------------------------------
    const aspect = container.clientWidth / container.clientHeight;
    camera = new THREE.PerspectiveCamera(55, aspect, 1, 5000);
    camera.position.set(600, 450, 600);
    camera.lookAt(0, 0, 0);

    // ------------------------------------------------------------------
    // RENDERER — WebGL output to canvas
    //
    // Antialiasing smooths edges. Pixel ratio matches the display for
    // sharp rendering on high-DPI screens.
    // ------------------------------------------------------------------
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // Style the canvas to match the UI (rounded corners)
    renderer.domElement.style.borderRadius = '10px';
    renderer.domElement.style.display = 'block';

    // ------------------------------------------------------------------
    // ORBIT CONTROLS — Interactive camera manipulation
    //
    // Left-drag: rotate around the center
    // Right-drag: pan the camera
    // Scroll: zoom in/out
    // Damping adds smooth deceleration after user interaction.
    // ------------------------------------------------------------------
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.minDistance = 100;
    controls.maxDistance = 2500;

    // ------------------------------------------------------------------
    // LIGHTING — brighter setup so fish colors are vivid
    //
    // Hemisphere light: underwater ambient, blue-white from above,
    // teal from below.
    // Directional light: main "sun" through the water surface.
    // Fill light: secondary directional from below-front to prevent
    // any face from being completely dark.
    // Ambient light: strong baseline so nothing disappears into black.
    // ------------------------------------------------------------------
    const hemiLight = new THREE.HemisphereLight('#88bbdd', '#2a5566', 1.5);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight('#ddeeff', 1.8);
    dirLight.position.set(200, 500, 300);
    scene.add(dirLight);

    // Fill light from below-front — softens shadows on undersides
    const fillLight = new THREE.DirectionalLight('#6699aa', 0.7);
    fillLight.position.set(-100, -300, 200);
    scene.add(fillLight);

    const ambLight = new THREE.AmbientLight('#aabbcc', 1.2);
    scene.add(ambLight);

    // Risk-tinting light: a red-ish hemisphere light whose intensity
    // is modulated by CONFIG.risk. At risk=0 it's invisible; at risk=1
    // it gives a subtle reddish ambient cast to the scene.
    riskLight = new THREE.HemisphereLight('#cc4444', '#441111', 0);
    scene.add(riskLight);

    // ------------------------------------------------------------------
    // BUILD VISUAL ELEMENTS
    // ------------------------------------------------------------------
    createBoundingBox();
    createCoverMeshes();
    createRiskMeshes();
    createFishMesh();
    createGlowPool();

    // ------------------------------------------------------------------
    // RESPONSIVE RESIZE
    // ------------------------------------------------------------------
    window.addEventListener('resize', () => onResize(container));
}


// ============================================================================
// Scene Elements
// ============================================================================

/**
 * Creates a wireframe box showing the simulation volume boundaries.
 * Helps the user understand the extent of the 3D space.
 */
function createBoundingBox() {
    const size = WORLD_SIZE * 2;
    const geo = new THREE.BoxGeometry(size, size, size);
    const edges = new THREE.EdgesGeometry(geo);
    const mat = new THREE.LineBasicMaterial({
        color: '#1C3E4E',
        transparent: true,
        opacity: 0.5
    });
    boundingBoxLine = new THREE.LineSegments(edges, mat);
    scene.add(boundingBoxLine);
    geo.dispose(); // We only need the edges
}

/**
 * Creates translucent green spheres for each reef cover patch.
 * These are static — their size/position doesn't change at runtime.
 * Only their visibility is toggled based on CONFIG.cover > 0.
 */
function createCoverMeshes() {
    // Dispose old meshes if any (for re-initialization)
    for (const m of coverMeshes) {
        m.geometry.dispose();
        m.material.dispose();
        scene.remove(m);
    }
    coverMeshes = [];

    const coverGeo = new THREE.SphereGeometry(1, 24, 16);

    for (const patch of COVER_PATCHES) {
        const mat = new THREE.MeshPhongMaterial({
            color: '#2F6B5E',
            transparent: true,
            opacity: 0.12,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(coverGeo, mat);
        mesh.position.copy(patch.center);
        mesh.scale.setScalar(patch.radius);
        scene.add(mesh);
        coverMeshes.push(mesh);
    }
}

/**
 * Creates translucent reddish spheres for each predation risk zone.
 * Same approach as cover meshes but with a threatening red color.
 */
function createRiskMeshes() {
    for (const m of riskMeshes) {
        m.geometry.dispose();
        m.material.dispose();
        scene.remove(m);
    }
    riskMeshes = [];

    const riskGeo = new THREE.SphereGeometry(1, 24, 16);

    for (const patch of RISK_PATCHES) {
        const mat = new THREE.MeshPhongMaterial({
            color: '#8B2020',
            transparent: true,
            opacity: 0.10,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(riskGeo, mat);
        mesh.position.copy(patch.center);
        mesh.scale.setScalar(patch.radius);
        scene.add(mesh);
        riskMeshes.push(mesh);
    }
}

/**
 * Creates the InstancedMesh for rendering all fish agents.
 *
 * InstancedMesh renders multiple copies of the same geometry in a
 * single draw call. Each instance (fish) gets its own transform
 * matrix and color. This is far more efficient than creating
 * individual Mesh objects for each fish.
 *
 * The fish shape is an elongated cone (pointy end = head, wide
 * end = tail), approximating a simple fish silhouette from all angles.
 */
function createFishMesh() {
    // Remove old mesh if it exists
    if (fishMesh) {
        fishMesh.geometry.dispose();
        fishMesh.material.dispose();
        scene.remove(fishMesh);
    }

    // Cone geometry: radiusTop=0 (point), radiusBottom=FISH_WIDTH/2,
    // height=FISH_LENGTH. The cone points along +Y by default;
    // we'll rotate it to point along +Z so it aligns with velocity.
    const geo = new THREE.ConeGeometry(FISH_WIDTH / 2, FISH_LENGTH, 6);
    // Rotate geometry so the cone tip points along +Z (forward direction).
    // ConeGeometry tip is at +Y by default. rotateX(-PI/2) maps +Y → +Z.
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshPhongMaterial({
        flatShading: true,
        shininess: 60,
        // Emissive gives each fish a self-lit glow so species colors
        // stay vivid even in shadow. The emissive color is white;
        // the per-instance color (set via setColorAt) tints it.
        emissive: '#ffffff',
        emissiveIntensity: 0.25
    });

    fishMesh = new THREE.InstancedMesh(geo, mat, MAX_AGENTS);
    fishMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Don't pre-create instanceColor — let Three.js create it properly
    // on the first setColorAt() call. Pre-creating with zeros gave
    // black (invisible) fish.
    fishMesh.count = 0; // Will be set each frame

    scene.add(fishMesh);
}

/**
 * Creates a pool of glow sphere meshes for mixed-group halos.
 *
 * Rather than creating/destroying meshes each frame (expensive),
 * we pre-allocate a pool and show/hide them as needed.
 * Each glow mesh is a simple sphere with emissive coral-orange color
 * and high transparency.
 */
function createGlowPool() {
    const glowGeo = new THREE.SphereGeometry(1, 16, 12);

    for (let i = 0; i < MAX_GLOW_MESHES; i++) {
        const mat = new THREE.MeshBasicMaterial({
            color: '#FF8C5A',
            transparent: true,
            opacity: 0.0,
            depthWrite: false,
            side: THREE.BackSide  // Render inside-out so it looks like a halo
        });
        const mesh = new THREE.Mesh(glowGeo, mat);
        mesh.visible = false;
        scene.add(mesh);
        glowMeshes.push(mesh);
    }
}


// ============================================================================
// updateScene() — Per-frame visual update from simulation state
// ============================================================================

/**
 * Reads the current agent positions/velocities and cluster state from
 * simulation.js and updates all visual elements accordingly.
 *
 * Called once per animation frame.
 *
 * @param {number} frame — Current frame number (for pulsing animations)
 */
export function updateScene(frame) {
    const n = agents.length;
    const elapsed = clock.getElapsedTime();

    // ------------------------------------------------------------------
    // UPDATE FISH INSTANCES
    //
    // For each agent, compute a transform matrix that:
    //   1. Positions the fish at its simulation coordinates
    //   2. Rotates it to face along its velocity vector
    //   3. Sets the species color
    // ------------------------------------------------------------------
    fishMesh.count = n;

    for (let i = 0; i < n; i++) {
        const agent = agents[i];

        // Position from simulation
        _position.copy(agent.position);

        // Rotation: orient the fish mesh to face along its velocity vector.
        // Matrix4.lookAt(eye, target, up) creates a rotation where -Z points
        // from eye toward target. Since our fish geometry nose is at +Z, we
        // swap the arguments so +Z faces the movement direction.
        //
        // Safety: if velocity is near-zero, lookAt produces NaN. In that
        // case we just skip rotation and use an identity orientation.
        const speed = agent.velocity.length();
        _matrix.identity();

        if (speed > 0.001) {
            _lookTarget.copy(agent.position).add(agent.velocity);
            _matrix.lookAt(_lookTarget, _position, _up);
        }

        _matrix.setPosition(_position);
        fishMesh.setMatrixAt(i, _matrix);

        // Species color
        _color.set(SPECIES_COLORS[agent.species]);
        fishMesh.setColorAt(i, _color);
    }

    fishMesh.instanceMatrix.needsUpdate = true;
    if (fishMesh.instanceColor) fishMesh.instanceColor.needsUpdate = true;

    // ------------------------------------------------------------------
    // UPDATE REEF COVER VISUALS
    //
    // Adjust opacity based on CONFIG.cover — when cover is 0, the
    // reef patches become invisible. At cover=1, they're at full opacity.
    // ------------------------------------------------------------------
    for (let i = 0; i < coverMeshes.length; i++) {
        const mesh = coverMeshes[i];
        const patch = COVER_PATCHES[i];
        const opacity = 0.12 * patch.baseIntensity * (CONFIG.cover / 0.45);
        mesh.material.opacity = Math.min(0.22, Math.max(0.02, opacity));
        mesh.visible = CONFIG.cover > 0.01;
    }

    // ------------------------------------------------------------------
    // UPDATE RISK ZONE VISUALS
    // ------------------------------------------------------------------
    for (let i = 0; i < riskMeshes.length; i++) {
        const mesh = riskMeshes[i];
        const patch = RISK_PATCHES[i];
        const opacity = 0.10 * patch.baseIntensity * (CONFIG.risk / 0.3);
        mesh.material.opacity = Math.min(0.20, Math.max(0.02, opacity));
        mesh.visible = CONFIG.risk > 0.01;
    }

    // ------------------------------------------------------------------
    // UPDATE RISK TINTING
    //
    // Modulate the red hemisphere light intensity by risk level.
    // At risk=0, no tinting. At risk=1, subtle reddish ambient.
    // ------------------------------------------------------------------
    riskLight.intensity = CONFIG.risk * 0.6;

    // ------------------------------------------------------------------
    // UPDATE MIXED-GROUP GLOW HALOS
    //
    // Find all clusters, identify mixed-species ones, and position
    // glow spheres at their centroids with pulsing opacity.
    // ------------------------------------------------------------------
    const clusters = findClusters();
    const mixedClusters = clusters.filter(g => {
        const speciesSet = new Set(g.map(a => a.species));
        return speciesSet.size > 1;
    });

    // Pulse factor: oscillates between 0.35 and 0.65, matching 2D timing
    const pulse = 0.55 + 0.25 * Math.sin(elapsed * 3.0);

    for (let i = 0; i < MAX_GLOW_MESHES; i++) {
        const glowMesh = glowMeshes[i];

        if (i < mixedClusters.length) {
            const group = mixedClusters[i];

            // Compute centroid of the cluster
            _centroid.set(0, 0, 0);
            for (const a of group) {
                _centroid.add(a.position);
            }
            _centroid.divideScalar(group.length);

            // Compute radius: max distance from centroid + padding
            let maxR = 20;
            for (const a of group) {
                const dist = a.position.distanceTo(_centroid);
                maxR = Math.max(maxR, dist + 14);
            }

            glowMesh.position.copy(_centroid);
            glowMesh.scale.setScalar(maxR);
            glowMesh.material.opacity = 0.12 * pulse;
            glowMesh.visible = true;
        } else {
            glowMesh.visible = false;
        }
    }

    // Update controls damping
    controls.update();
}


// ============================================================================
// render() — Draw the scene to the canvas
// ============================================================================

/**
 * Renders one frame. Call after updateScene().
 */
export function render() {
    renderer.render(scene, camera);
}


// ============================================================================
// rebuildFishMesh() — Rebuild InstancedMesh when agent count changes
// ============================================================================

/**
 * Call this after initAgents() to ensure the InstancedMesh has fresh
 * colors and transforms. The mesh supports up to MAX_AGENTS instances,
 * so we just update the count rather than recreating it.
 */
export function rebuildFishMesh() {
    // No need to recreate — just update count on next updateScene()
    // The InstancedMesh is pre-allocated to MAX_AGENTS
}

/**
 * Rebuilds the bounding box wireframe when CONFIG.worldSizeX/Y/Z change.
 */
export function rebuildBoundingBox() {
    if (boundingBoxLine) {
        boundingBoxLine.geometry.dispose();
        boundingBoxLine.material.dispose();
        scene.remove(boundingBoxLine);
    }
    const sx = CONFIG.worldSizeX * 2;
    const sy = CONFIG.worldSizeY * 2;
    const sz = CONFIG.worldSizeZ * 2;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const edges = new THREE.EdgesGeometry(geo);
    const mat = new THREE.LineBasicMaterial({
        color: '#1C3E4E',
        transparent: true,
        opacity: 0.5
    });
    boundingBoxLine = new THREE.LineSegments(edges, mat);
    scene.add(boundingBoxLine);
    geo.dispose();
}


// ============================================================================
// Resize handler
// ============================================================================

function onResize(container) {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}


// ============================================================================
// getClusterData() — Expose cluster info for the metrics panel
// ============================================================================

/**
 * Returns processed cluster data for the UI metrics panel.
 * Avoids calling findClusters() twice per frame by caching.
 *
 * @returns {{ total: number, mixed: number, clusters: Array }}
 */
export function getClusterData() {
    const clusters = findClusters();
    const mixed = clusters.filter(g => {
        const speciesSet = new Set(g.map(a => a.species));
        return speciesSet.size > 1;
    });

    return {
        total: clusters.length,
        mixed: mixed.length,
        clusters: clusters
    };
}
