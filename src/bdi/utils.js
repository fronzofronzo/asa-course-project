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

function computeSpawnHeat(tile, tiles, radius) {
    let heat = 0;
    console.log(tiles)
    for (const t of tiles) {
        if (t.type !== 1) continue; // only consider other spawn tiles
        const dist = Math.hypot(t.x - tile.x, t.y - tile.y);
        if (dist <= radius) {
            heat += 1 / (1 + dist);
        }
    }
    return heat;
}

export { bfsDist, bfsDistDirected, computeSpawnHeat };
