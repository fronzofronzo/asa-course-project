import { go_to, bfsDist } from './deliberation.js';

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
 * Move toward nearest unvisited spawn tile to discover new parcels.
 * Marks tile visited once reached. Resets visited set when all tiles explored.
 * Returns true when a new tile is reached, false if unreachable.
 * @param {object} agent
 * @param {Set<string>} visitedSpawns  shared set tracking visited spawn keys
 * @returns {Promise<boolean>}
 */
async function explore(agent, visitedSpawns) {
    const { spawnTiles, walkable } = agent.beliefs.map;

    if (spawnTiles.length === 0) {
        console.warn('explore: no spawn tiles in map');
        return false;
    }

    const agentPos = { x: Math.round(agent.x), y: Math.round(agent.y) };
    const unvisited = spawnTiles.filter(t => !visitedSpawns.has(`${t.x},${t.y}`));

    // reset when all tiles visited so agent keeps roaming
    const candidates = unvisited.length > 0 ? unvisited : (visitedSpawns.clear(), spawnTiles);

    const nearest = candidates.reduce((best, tile) => {
        const d = bfsDist(agentPos, tile, walkable);
        return d < best.dist ? { tile, dist: d } : best;
    }, { tile: null, dist: Infinity });

    if (!nearest.tile || nearest.dist === Infinity) {
        console.warn('explore: no reachable spawn tile');
        return false;
    }

    const arrived = await go_to({ x: nearest.tile.x, y: nearest.tile.y }, agent);
    if (arrived) {
        visitedSpawns.add(`${nearest.tile.x},${nearest.tile.y}`);
        console.log(`Explored spawn tile (${nearest.tile.x},${nearest.tile.y})`);
    }
    return arrived;
}

export { go_pick_up, deliver, explore };
