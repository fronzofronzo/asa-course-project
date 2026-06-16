import { go_to } from './deliberation.js';
import { bfsDist, bfsDistDirected, getEffectiveDeliveryTiles } from './utils.js';
import { log } from './logger.js';

const UNREACHABLE_TIMEOUT_MS = 10000; // if delivery tile unreachable for this long, consider it blocked

/**
 * Returns nearest reachable delivery tile, or null.
 * @param {object} agent
 * @returns {{ x:number, y:number } | null}
 */
function nearestDeliveryTile(agent, unreachableDeliveryTiles) {
    const { deliveryTiles, walkable, exitDirs } = agent.beliefs.map;
    const effectiveDeliveryTiles = getEffectiveDeliveryTiles(deliveryTiles, agent.beliefs.missionConstraints ?? null);
    const agentPos = { x: Math.round(agent.x), y: Math.round(agent.y) };
    let best = null, bestScore = Infinity;
    for (const tile of effectiveDeliveryTiles) {
        const elapsed = Date.now() - (unreachableDeliveryTiles.get(`${tile.x},${tile.y}`) || 0);
        const unreachablePenalty = Math.max(0, 1 - elapsed / UNREACHABLE_TIMEOUT_MS);
        const d = bfsDistDirected(agentPos, tile, walkable, exitDirs);
        const score = d + unreachablePenalty * 1000; // add large penalty to unreachable tiles, decaying over time
        if (score < bestScore) { bestScore = score; best = tile; }
    }
    return bestScore < Infinity ? best : null;
}


function computeBestSpawnTile(agent, visitedSpawns) {
    const { spawnTiles, walkable, exitDirs } = agent.beliefs.map;
    if (spawnTiles.length === 0) return null;
    const agentPos = { x: Math.round(agent.x), y: Math.round(agent.y) };
    const candidates = spawnTiles;
    let best = null, bestScore = -Infinity;
    for (const tile of candidates) {
        const d = bfsDistDirected(agentPos, tile, walkable, exitDirs);
        if (d === Infinity) continue;
        const distScore = 1 / (d + 1);
        const heatScore = agent.beliefs.map.spawnHeat.get(`${tile.x},${tile.y}`) || 0;

        // Multiplicative factors: 0 = fully suppressed, 1 = no penalty
        const lastVisit = visitedSpawns.get(`${tile.x},${tile.y}`) || 0;
        const elapsed = lastVisit === 0 ? Infinity : Date.now() - lastVisit;
        const recencyFactor = Math.min(1, elapsed / 30000); // 0 just visited → 1 after 30s

        const nearbyAgents = [...agent.beliefs.agents.values()]
            .filter(a => Math.abs(a.x - tile.x) + Math.abs(a.y - tile.y) <= 2).length;
        const agentFactor = Math.max(0, 1 - nearbyAgents * 0.4); // 0 at 3+ agents

        const score = (distScore + heatScore) * recencyFactor * agentFactor;
        if (score > bestScore) { bestScore = score; best = tile; }
    }
    return best;
}

export { nearestDeliveryTile, computeBestSpawnTile };
