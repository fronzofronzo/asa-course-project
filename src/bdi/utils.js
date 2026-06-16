/**
 * BFS shortest-path distance on the walkability graph.
 * Returns Infinity if unreachable.
 * @param {{ x:number, y:number }} from
 * @param {{ x:number, y:number }} to
 * @param {Set<string>} walkable
 * @returns {number}
 */
function bfsDist(from, to, walkable) {
    const goal  = `${to.x},${to.y}`;
    const start = `${from.x},${from.y}`;
    if (start === goal) return 0;
    if (!walkable.has(start) || !walkable.has(goal)) return Infinity;
    const queue   = [[from.x, from.y, 0]];
    const visited = new Set([start]);
    const dirs    = [[1,0],[-1,0],[0,1],[0,-1]];
    while (queue.length) {
        const [x, y, d] = queue.shift();
        for (const [dx, dy] of dirs) {
            const nx = x + dx, ny = y + dy;
            const key = `${nx},${ny}`;
            if (key === goal) return d + 1;
            if (!visited.has(key) && walkable.has(key)) { visited.add(key); queue.push([nx, ny, d + 1]); }
        }
    }
    return Infinity;
}

/**
 * Directed BFS respecting one-way tile constraints (exitDirs).
 * Use this when selecting navigation targets — matches what A* can actually traverse.
 * @param {{ x:number, y:number }} from
 * @param {{ x:number, y:number }} to
 * @param {Set<string>} walkable
 * @param {Map<string, Set<string>>} exitDirs
 * @returns {number}
 */
function bfsDistDirected(from, to, walkable, exitDirs) {
    const goal  = `${to.x},${to.y}`;
    const start = `${from.x},${from.y}`;
    if (start === goal) return 0;
    if (!walkable.has(start) || !walkable.has(goal)) return Infinity;
    const DIRS = [
        { dx:  0, dy:  1, dir: 'up'    },
        { dx:  0, dy: -1, dir: 'down'  },
        { dx:  1, dy:  0, dir: 'right' },
        { dx: -1, dy:  0, dir: 'left'  },
    ];
    const queue   = [[from.x, from.y, 0]];
    const visited = new Set([start]);
    while (queue.length) {
        const [x, y, d] = queue.shift();
        const allowed = exitDirs.get(`${x},${y}`);
        for (const { dx, dy, dir } of DIRS) {
            if (allowed && !allowed.has(dir)) continue;
            const nx = x + dx, ny = y + dy;
            const nkey = `${nx},${ny}`;
            if (nkey === goal) return d + 1;
            if (!visited.has(nkey) && walkable.has(nkey)) {
                visited.add(nkey);
                queue.push([nx, ny, d + 1]);
            }
        }
    }
    return Infinity;
}

/**
 * Computes a heat value for a spawn tile based on density of nearby spawn tiles.
 * Higher heat = more spawn neighbors within `radius`.
 * Uses inverse-distance weighting: closer neighbors contribute more (`1 / (1 + dist)`).
 * @param {{ x:number, y:number }} tile - Target spawn tile.
 * @param {import('@unitn-asa/deliveroo-js-sdk/src/types/IOTile').IOTile[]} tiles - Full tile list.
 * @param {number} radius - Euclidean radius to consider.
 * @returns {number} Heat value (higher = denser spawn cluster).
 */
function computeSpawnHeat(tile, tiles, radius) {
    let heat = 0.0;
    for (const t of tiles) {
        
        if (t.type == 1) // only consider other spawn tiles
        {
            // console.log(`Checking tile (${t.x},${t.y}) of type ${t.type}`);
            const dist = Math.hypot(t.x - tile.x, t.y - tile.y);
            if (dist <= radius) {
                heat += 1 / (1 + dist);
            }
        }
    }
    return heat;
}

/**
 * Filter delivery tiles by mission constraints (preferred + blacklist).
 * Falls back to full list if filtering would leave no tiles.
 * @param {{ x:number, y:number }[]} all
 * @param {import('./llm/constraints/MissionConstraints.js').MissionConstraints|null} constraints
 * @returns {{ x:number, y:number }[]}
 */
function getEffectiveDeliveryTiles(all, constraints) {
    if (!constraints) return all;
    let tiles = all;
    const pref = constraints.preferred.tiles;
    if (pref && pref.length > 0) {
        const filtered = all.filter(t => pref.some(p => p.x === t.x && p.y === t.y));
        if (filtered.length > 0) tiles = filtered;
    }
    const bl = constraints.blacklist.tiles;
    if (bl && bl.size > 0) {
        const filtered = tiles.filter(t => !bl.has(`${t.x},${t.y}`));
        if (filtered.length > 0) tiles = filtered;
    }
    // A forbidden tile can't be entered → it can't be a delivery destination either.
    const fb = constraints.forbidden?.tiles;
    if (fb && fb.size > 0) {
        const filtered = tiles.filter(t => !fb.has(`${t.x},${t.y}`));
        if (filtered.length > 0) tiles = filtered;
    }
    return tiles;
}

/**
 * Nearest walkable tile to (x,y) whose Manhattan distance is <= maxDist.
 * Used for rendezvous: the requested point may be non-walkable, but the mission only
 * needs an agent within maxDist of it. Returns the closest reachable approach tile, or null.
 * Matches the arrival metric in agent.js (Manhattan distance to the target).
 * @param {Set<string>} walkable - set of "x,y" walkable keys
 * @param {number} x
 * @param {number} y
 * @param {number} maxDist
 * @returns {{ x:number, y:number }|null}
 */
function nearestWalkableWithin(walkable, x, y, maxDist) {
    const tx = Math.round(x), ty = Math.round(y);
    if (walkable.has(`${tx},${ty}`)) return { x: tx, y: ty };
    let best = null, bestDist = Infinity;
    for (const key of walkable) {
        const [wx, wy] = key.split(',').map(Number);
        const d = Math.abs(wx - tx) + Math.abs(wy - ty);
        if (d <= maxDist && d < bestDist) { bestDist = d; best = { x: wx, y: wy }; }
    }
    return best;
}

export { bfsDist, bfsDistDirected, computeSpawnHeat, getEffectiveDeliveryTiles, nearestWalkableWithin };
