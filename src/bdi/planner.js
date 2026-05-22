import { go_to } from './deliberation.js';
import { bfsDist, bfsDistDirected } from './utils.js';

/**
 * Go to parcel tile and pick it up.
 * Returns true if picked up, false if parcel gone or unreachable.
 * @param {{ id:string, x:number, y:number }} parcel
 * @param {object} agent
 * @returns {Promise<boolean>}
 */
async function go_pick_up(parcel, agent) {
    const arrived = await go_to({ x: parcel.x, y: parcel.y }, agent);
    if (!arrived) return false;

    const pickedUp = await agent.socket.emitPickup();

    if (!pickedUp || pickedUp.length === 0) {
        console.warn(`go_pick_up: arrived at (${parcel.x},${parcel.y}) but no parcel picked up`);
        return false;
    }

    console.log(`Picked up ${pickedUp.length} parcel(s) at (${parcel.x},${parcel.y})`);
    return true;
}

/**
 * Go to nearest delivery tile and put down all carried parcels.
 * Returns true on successful delivery, false if no delivery tile reachable.
 * @param {object} agent
 * @returns {Promise<boolean>}
 */
async function deliver(agent) {
    const { deliveryTiles, walkable } = agent.beliefs.map;

    if (deliveryTiles.length === 0) {
        console.warn('deliver: no delivery tiles in map');
        return false;
    }

    const agentPos = { x: Math.round(agent.x), y: Math.round(agent.y) };
    const nearest = deliveryTiles.reduce((best, tile) => {
        const d = bfsDist(agentPos, tile, walkable);
        return d < best.dist ? { tile, dist: d } : best;
    }, { tile: null, dist: Infinity });

    if (!nearest.tile) {
        console.warn('deliver: no reachable delivery tile');
        return false;
    }

    const arrived = await go_to({ x: nearest.tile.x, y: nearest.tile.y }, agent);
    if (!arrived) return false;

    const dropped = await agent.socket.emitPutdown();
    console.log(`Delivered ${dropped.length} parcel(s) at (${nearest.tile.x},${nearest.tile.y})`);
    return true;
}

/**
 * Move toward best spawn tile (highest utility score).
 * Records visit timestamp on arrival.
 * @param {object} agent
 * @param {Map<string, number>} visitedSpawns  key → timestamp of last visit
 * @returns {Promise<boolean>}
 */
async function explore(agent, visitedSpawns) {
    const best = nearestSpawnTile(agent, visitedSpawns);

    if (!best) {
        console.warn('explore: no reachable spawn tile');
        return false;
    }

    const arrived = await go_to({ x: best.x, y: best.y }, agent);
    if (arrived) {
        visitedSpawns.set(`${best.x},${best.y}`, Date.now());
        console.log(`Explored spawn tile (${best.x},${best.y})`);
    }
    return arrived;
}

/**
 * Returns nearest reachable delivery tile, or null.
 * @param {object} agent
 * @returns {{ x:number, y:number } | null}
 */
function nearestDeliveryTile(agent) {
    const { deliveryTiles, walkable, exitDirs } = agent.beliefs.map;
    const agentPos = { x: Math.round(agent.x), y: Math.round(agent.y) };
    let best = null, bestDist = Infinity;
    for (const tile of deliveryTiles) {
        const d = bfsDistDirected(agentPos, tile, walkable, exitDirs);
        if (d < bestDist) { bestDist = d; best = tile; }
    }
    return bestDist < Infinity ? best : null;
}

/**
 * Returns best reachable spawn tile by utility score.
 * score = 1/(dist+1) - SPAWN_W_AGENTS * nearbyAgentCount - SPAWN_W_RECENCY * recencyPenalty
 * recencyPenalty decays from 1 (just visited) to 0 after SPAWN_RECENCY_WINDOW_MS.
 * @param {object} agent
 * @param {Map<string, number>} visitedSpawns  key → timestamp of last visit
 * @returns {{ x:number, y:number } | null}
 */
function nearestSpawnTile(agent, visitedSpawns) {
    const { spawnTiles, walkable, exitDirs } = agent.beliefs.map;
    if (spawnTiles.length === 0) return null;
    const agentPos = { x: Math.round(agent.x), y: Math.round(agent.y) };
    const unvisited = spawnTiles.filter(t => !visitedSpawns.has(`${t.x},${t.y}`));
    const candidates = unvisited.length > 0 ? unvisited : (visitedSpawns.clear(), spawnTiles);
    let best = null, bestDist = Infinity;
    for (const tile of candidates) {
        const d = bfsDistDirected(agentPos, tile, walkable, exitDirs);
        if (d < bestDist) { bestDist = d; best = tile; }
    }
    return best;
}

function hottestSpawnTile(agent, visitedSpawns) {
    const { spawnTiles, spawnHeat } = agent.beliefs.map;
    if (spawnTiles.length === 0) return null;
    const unvisited = spawnTiles.filter(t => !visitedSpawns.has(`${t.x},${t.y}`));
    const candidates = unvisited.length > 0 ? unvisited : spawnTiles;
    let best = null, bestHeat = -Infinity;
    for (const tile of candidates) {
        const heat = spawnHeat.get(`${tile.x},${tile.y}`);
        if (heat > bestHeat) { bestHeat = heat; best = tile; }
    }
    return best;
}

export { go_pick_up, deliver, explore, nearestDeliveryTile, nearestSpawnTile };
