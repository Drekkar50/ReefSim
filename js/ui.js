/**
 * ============================================================================
 * ui.js — Control Panel & Metrics Panel Bindings
 * ============================================================================
 *
 * Connects the HTML control panel (sliders, buttons) to the simulation
 * CONFIG, and updates the live metrics display (group counts, composition).
 *
 * This module handles:
 *   • Binding slider inputs to CONFIG properties
 *   • Regenerate / Pause button behavior
 *   • Building the species color legend
 *   • Updating the metrics panel with cluster analysis results
 *
 * ============================================================================
 */

import {
    CONFIG, SPECIES_COLORS, SPECIES_NAMES, initAgents, findClusters
} from './simulation.js';

import { rebuildFishMesh, rebuildBoundingBox } from './renderer.js';


// ============================================================================
// bindControls() — Wire up all UI elements
// ============================================================================

/**
 * Binds all slider inputs and buttons to their respective actions.
 * Call once after the DOM is ready.
 *
 * @param {Function} onReset — Callback to invoke after regenerating agents
 *                              (e.g., to rebuild the InstancedMesh)
 */
export function bindControls(onReset) {
    // ------------------------------------------------------------------
    // SLIDER: Species Count (1–5)
    // ------------------------------------------------------------------
    const speciesEl = document.getElementById('species-count');
    speciesEl.addEventListener('input', (e) => {
        CONFIG.speciesCount = +e.target.value;
        document.getElementById('val-species').textContent = CONFIG.speciesCount;
    });

    // ------------------------------------------------------------------
    // SLIDER: Individuals Per Species (4–30)
    // ------------------------------------------------------------------
    const individualsEl = document.getElementById('individuals-count');
    individualsEl.addEventListener('input', (e) => {
        CONFIG.individualsPerSpecies = +e.target.value;
        document.getElementById('val-individuals').textContent = CONFIG.individualsPerSpecies;
    });

    // ------------------------------------------------------------------
    // SLIDERS: World Size X / Y / Z (100–800 half-extent per axis)
    //
    // Changes the dimensions of the simulation volume independently.
    // Rebuilds the bounding box wireframe to match.
    // ------------------------------------------------------------------
    const worldXEl = document.getElementById('world-size-x');
    worldXEl.addEventListener('input', (e) => {
        CONFIG.worldSizeX = +e.target.value;
        document.getElementById('val-worldx').textContent = CONFIG.worldSizeX;
        rebuildBoundingBox();
    });

    const worldYEl = document.getElementById('world-size-y');
    worldYEl.addEventListener('input', (e) => {
        CONFIG.worldSizeY = +e.target.value;
        document.getElementById('val-worldy').textContent = CONFIG.worldSizeY;
        rebuildBoundingBox();
    });

    const worldZEl = document.getElementById('world-size-z');
    worldZEl.addEventListener('input', (e) => {
        CONFIG.worldSizeZ = +e.target.value;
        document.getElementById('val-worldz').textContent = CONFIG.worldSizeZ;
        rebuildBoundingBox();
    });

    // ------------------------------------------------------------------
    // SLIDER: Mixing Tendency (0.00–1.00)
    //
    // Controls how strongly fish respond to other species:
    //   0 = ignore heterospecifics (species-segregated groups)
    //   1 = treat all species equally (fully mixed groups)
    // ------------------------------------------------------------------
    const mixingEl = document.getElementById('mixing');
    mixingEl.addEventListener('input', (e) => {
        CONFIG.mixing = +e.target.value;
        document.getElementById('val-mixing').textContent = CONFIG.mixing.toFixed(2);
    });

    // ------------------------------------------------------------------
    // SLIDER: Reef Cover (0.00–1.00)
    //
    // Global scaling of reef structural complexity. Higher values
    // make the cover patches more effective at reducing perception.
    // ------------------------------------------------------------------
    const coverEl = document.getElementById('cover');
    coverEl.addEventListener('input', (e) => {
        CONFIG.cover = +e.target.value;
        document.getElementById('val-cover').textContent = CONFIG.cover.toFixed(2);
    });

    // ------------------------------------------------------------------
    // SLIDER: Predation Risk (0.00–1.00)
    //
    // Higher risk expands attraction zones, producing tighter groups.
    // ------------------------------------------------------------------
    const riskEl = document.getElementById('risk');
    riskEl.addEventListener('input', (e) => {
        CONFIG.risk = +e.target.value;
        document.getElementById('val-risk').textContent = CONFIG.risk.toFixed(2);
    });

    // ------------------------------------------------------------------
    // BUTTON: Regenerate — re-initializes agents with current CONFIG
    // ------------------------------------------------------------------
    document.getElementById('btn-reset').addEventListener('click', () => {
        buildLegend();
        initAgents();
        rebuildFishMesh();
        if (onReset) onReset();
    });

    // ------------------------------------------------------------------
    // BUTTON: Pause / Resume — toggles simulation stepping
    // ------------------------------------------------------------------
    const pauseBtn = document.getElementById('btn-pause');
    pauseBtn._running = true;  // Track state on the element
    pauseBtn.addEventListener('click', () => {
        pauseBtn._running = !pauseBtn._running;
        pauseBtn.textContent = pauseBtn._running ? 'Pause' : 'Resume';
    });
}


/**
 * Returns whether the simulation is currently running (not paused).
 */
export function isRunning() {
    const btn = document.getElementById('btn-pause');
    return btn._running !== false;
}


// ============================================================================
// buildLegend() — Populate the species color legend
// ============================================================================

/**
 * Builds the legend overlay showing species names and their colors.
 * Call after changing CONFIG.speciesCount.
 */
export function buildLegend() {
    const el = document.getElementById('legend');
    el.innerHTML = '';

    for (let s = 0; s < CONFIG.speciesCount; s++) {
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML = `<span class="legend-dot" style="background:${SPECIES_COLORS[s]}"></span>${SPECIES_NAMES[s]}`;
        el.appendChild(item);
    }
}


// ============================================================================
// updateMetrics() — Refresh the live metrics panel
// ============================================================================

/**
 * Updates the metrics sidebar with current cluster analysis:
 *   • Number of mixed-species groups
 *   • Total group count
 *   • Per-group composition breakdown (species chips + size)
 *
 * This reads directly from findClusters() each time it's called.
 * Called every ~20 frames from the main loop (not every frame, to
 * avoid excessive DOM updates).
 */
export function updateMetrics() {
    const clusters = findClusters();
    const mixed = clusters.filter(g => {
        const speciesSet = new Set(g.map(a => a.species));
        return speciesSet.size > 1;
    });

    // Update headline numbers
    document.getElementById('mixed-count').textContent = mixed.length;
    document.getElementById('mixed-caption').textContent =
        `mixed-species groups (of ${clusters.length} total)`;

    // Build the group list
    const list = document.getElementById('group-list');
    list.innerHTML = '';

    if (clusters.length === 0) {
        list.innerHTML = '<div class="empty-note">No groups of 2+ currently formed.</div>';
        return;
    }

    // Sort by size (largest first) and show top 12
    const sorted = [...clusters].sort((a, b) => b.length - a.length).slice(0, 12);

    for (const g of sorted) {
        const speciesSet = new Set(g.map(a => a.species));
        const isMixed = speciesSet.size > 1;

        const row = document.createElement('div');
        row.className = 'group-row' + (isMixed ? ' mixed' : '');

        // Species composition dots
        const chips = [...speciesSet].sort().map(s =>
            `<span class="chip" style="background:${SPECIES_COLORS[s]}"></span>`
        ).join('');

        // Label: "mixed" or species name for single-species groups
        const label = isMixed ? 'mixed' : SPECIES_NAMES[[...speciesSet][0]];

        row.innerHTML = `<div class="composition">${chips}</div><span>${label}</span><span class="group-size">${g.length}</span>`;
        list.appendChild(row);
    }
}
