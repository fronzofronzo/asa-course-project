import { bfsDist, getEffectiveDeliveryTiles } from './utils.js';

/**
 * Nearest delivery tile distance from a given position.
 * @param {{ x:number, y:number }} pos
 * @param {{ x:number, y:number }[]} deliveryTiles
 * @param {Set<string>} walkable
 * @returns {number}
 */
function distToNearestDelivery(pos, deliveryTiles, walkable) {
    let best = Infinity;
    for (const d of deliveryTiles) {
        const dist = bfsDist(pos, d, walkable);
        if (dist < best) best = dist;
    }
    return best;
}

/**
 * Compute utility for a parcel target.
 * U(p) = reward(p) - decay*steps_to_p - decay*steps_to_delivery(p) - decay*steps_to_p*carried_count - agent_proximity_penalty
 * @param {{ x:number, y:number, reward:number }} parcel
 * @param {{ x:number, y:number }} agentPos
 * @param {number} carriedCount
 * @param {{ x:number, y:number }[]} deliveryTiles
 * @param {Set<string>} walkable
 * @param {number} decay
 * @param {Map<string, { id, name, x, y }>} otherAgents  other agents in sensing range
 * @returns {number}
 */
const BELIEF_THRESHOLD = 0.1;

function computeUtility(parcel, agentPos, carriedCount, deliveryTiles, walkable, decay, otherAgents = new Map(), constraints = null) {
    // parcel with low belief score is probably gone — skip immediately
    if ((parcel.beliefScore ?? 1.0) < BELIEF_THRESHOLD) return -Infinity;
    // skip parcels exceeding reward cap
    if (constraints?.rewardCap !== null && constraints?.rewardCap !== undefined && parcel.reward > constraints.rewardCap) return -Infinity;

    const stepsToParcel = bfsDist(agentPos, parcel, walkable);
    if (stepsToParcel === Infinity) return -Infinity;

    const stepsToDelivery = distToNearestDelivery(parcel, deliveryTiles, walkable);
    if (stepsToDelivery === Infinity) return -Infinity;

    // gameReward: actual reward the server will give if we reach the parcel now
    const stepsSinceLastSeen = (Date.now() - parcel.lastSeen) / 1000;
    const gameReward = Math.max(0, parcel.reward - decay * stepsSinceLastSeen);

    // effectiveReward: expected value = gameReward * P(parcel still exists)
    const effectiveReward = gameReward * (parcel.beliefScore ?? 1.0);

    const stepsToDeliveryNow = carriedCount > 0
      ? distToNearestDelivery(agentPos, deliveryTiles, walkable)
      : 0;

    const detoursSteps = stepsToParcel + stepsToDelivery - stepsToDeliveryNow;

    return effectiveReward
        - decay * (stepsToParcel + stepsToDelivery)
        - decay * carriedCount * detoursSteps;
}

/**
 * Generate desires: all options sorted by utility desc.
 * Emits PICKUP, DELIVER, and GOTO desires.
 * @param {import('./belief.js').BeliefSet} beliefs
 * @param {{ x:number, y:number }} agentPos
 * @param {number} carriedCount
 * @param {number} carriedReward
 * @param {number} decay
 * @param {number} threshold
 * @returns {{ type: string, id: string, utility: number }[]}
 */
function generateOptions(beliefs, agentPos, carriedCount, carriedReward, decay, threshold) {
    const { deliveryTiles, walkable } = beliefs.map;
    const constraints = beliefs.missionConstraints ?? null;
    const effectiveDeliveryTiles = getEffectiveDeliveryTiles(deliveryTiles, constraints);
    const desires = [];

    // PICKUP desires — skip entirely if stack.max reached
    const atStackMax = constraints?.stack?.max !== null && constraints?.stack?.max !== undefined
        && carriedCount >= constraints.stack.max;
    if (!atStackMax) {
        for (const parcel of beliefs.parcels.values()) {
            if (parcel.carriedBy !== null) continue;
            const utility = computeUtility(parcel, agentPos, carriedCount, effectiveDeliveryTiles, walkable, decay, beliefs.agents, constraints);
            if (utility > threshold) {
                desires.push({ type: 'PICKUP', id: parcel.id, parcel, utility });
            }
        }
    }

    // DELIVER desire — only when carrying, no viable pickups visible, and stack constraint satisfied
    if (carriedCount > 0 && desires.length === 0) {
        const stackMin = constraints?.stack?.min ?? null;
        const stackReady = stackMin === null || carriedCount >= stackMin;
        if (stackReady) {
            const distDel = distToNearestDelivery(agentPos, effectiveDeliveryTiles, walkable);
            const utility = carriedReward - decay * distDel;
            desires.push({ type: 'DELIVER', id: 'DELIVER', utility });
        }
        // if !stackReady: desires stays empty → agent explores to find more parcels
        // true deadlock (no parcels ever) is handled by the execution guard in agent.js
    }

    // GOTO desires — LLM-injected tile goals
    for (const [key, utility] of beliefs.tileUtilities) {
        const [x, y] = key.split(',').map(Number);
        desires.push({ type: 'GOTO', id: `GOTO:${key}`, tile: { x, y }, utility });
    }

    desires.sort((a, b) => b.utility - a.utility);
    return desires;
}

/**
 * Select intention from desires with hysteresis: only switch if new_U > current_U + epsilon.
 * Returns null if no viable desire.
 * @param {{ parcel: object, utility: number }[]} desires
 * @param {{ parcel: object, utility: number } | null} currentIntention
 * @param {number} epsilon
 * @returns {{ parcel: object, utility: number } | null}
 */
function filterIntentions(desires, currentIntention, epsilon) {
    if (desires.length === 0) return null;

    const best = desires[0];

    if (currentIntention === null) return best;

    // re-check current intention still in desires (parcel may be gone)
    const currentStillValid = desires.find(d => d.id === currentIntention.id);
    if (!currentStillValid) return best;

    // only switch if significantly better
    if (best.utility > currentStillValid.utility + epsilon) return best;

    return currentStillValid;
}

/**
 * A* on walkability graph. Respects directional tiles via exitDirs.
 * @param {{ x:number, y:number }} from  agent current position (may be fractional)
 * @param {{ x:number, y:number }} to    target tile
 * @param {Set<string>} walkable
 * @param {Map<string, Set<string>>} exitDirs  per-tile allowed exit directions; absent = all
 * @param {Map<string, object>} knownAgents  belief agents (their tiles are avoided)
 * @returns {string[] | null}
 */
function computePath(from, to, walkable, exitDirs, knownAgents, forbiddenTiles = new Set()) {
    const sx = Math.round(from.x), sy = Math.round(from.y);
    const gx = to.x, gy = to.y;
    const startKey = `${sx},${sy}`;
    const goalKey  = `${gx},${gy}`;

    if (startKey === goalKey) return [];
    if (!walkable.has(goalKey)) {
        console.warn(`[PATHFIND] Target (${gx},${gy}) is not walkable`);
        return null;
    }
    if (!walkable.has(startKey)) {
        console.warn(`[PATHFIND] Start (${sx},${sy}) is not walkable`);
        return null;
    }

    const blocked = new Set(
        [...knownAgents.values()].map(a => `${Math.round(a.x)},${Math.round(a.y)}`)
    );
    for (const key of forbiddenTiles) blocked.add(key);
    blocked.delete(startKey);
    if (blocked.size > 0) {
        console.log(`[PATHFIND] ${blocked.size} tile(s) blocking (agents + forbidden)`);
    }

    const h = (x, y) => Math.abs(x - gx) + Math.abs(y - gy);
    const dirs = [
        { dx:  0, dy:  1, dir: 'up'    },
        { dx:  0, dy: -1, dir: 'down'  },
        { dx:  1, dy:  0, dir: 'right' },
        { dx: -1, dy:  0, dir: 'left'  },
    ];

    // open: [f, g, x, y, path[]]
    const open = [[h(sx, sy), 0, sx, sy, []]];
    const visited = new Map();

    while (open.length) {
        open.sort((a, b) => a[0] - b[0]);
        const [, g, x, y, path] = open.shift();
        const key = `${x},${y}`;

        if (key === goalKey) {
            console.log(`[PATHFIND] ✓ Found path (${path.length} steps): [${path.slice(0, 10).join(',')}${path.length > 10 ? '...' : ''}]`);
            return path;
        }
        if ((visited.get(key) ?? Infinity) <= g) continue;
        visited.set(key, g);

        const allowed = exitDirs.get(key); // undefined = all directions OK
        for (const { dx, dy, dir } of dirs) {
            if (allowed && !allowed.has(dir)) continue; // tile restricts this exit
            const nx = x + dx, ny = y + dy;
            const nkey = `${nx},${ny}`;
            if (!walkable.has(nkey) || blocked.has(nkey)) continue;
            const ng = g + 1;
            if ((visited.get(nkey) ?? Infinity) <= ng) continue;
            open.push([ng + h(nx, ny), ng, nx, ny, [...path, dir]]);
        }
    }
    console.warn(`[PATHFIND] ✗ No path found (open list exhausted) from (${sx},${sy}) to (${gx},${gy})`);
    return null;
}

/**
 * Navigate agent to target tile step by step. Replans each step to react to opponents.
 * @param {{ x:number, y:number }} target
 * @param {{ x:number, y:number, beliefs: import('./belief.js').BeliefSet, socket: object }} agent
 * @returns {Promise<boolean>} true on arrival, false if stuck
 */
async function go_to(target, agent) {
    while (true) {
        const path = computePath(
            { x: agent.x, y: agent.y },
            target,
            agent.beliefs.map.walkable,
            agent.beliefs.map.exitDirs,
            agent.beliefs.agents
        );

        if (path === null) {
            console.warn(`go_to(${target.x},${target.y}): unreachable`);
            return false;
        }
        if (path.length === 0) return true;

        const result = await agent.socket.emitMove(path[0]);

        if (result === false) {
            console.warn(`go_to: move ${path[0]} failed, replanning`);
            continue;
        }

        agent.x = result.x;
        agent.y = result.y;

        if (Math.round(agent.x) === target.x && Math.round(agent.y) === target.y) {
            return true;
        }
    }
}

/**
 * Execute ONE move step toward target. Returns 'arrived' | 'moved' | 'stuck'.
 * @param {{ x:number, y:number }} target
 * @param {object} agent
 * @returns {Promise<'arrived'|'moved'|'stuck'>}
 */
async function stepToward(target, agent) {
    const from = { x: agent.x, y: agent.y };
    const to = target;
    
    const targetKey = `${to.x},${to.y}`;
    const isWalkable = agent.beliefs.map.walkable.has(targetKey);
    console.log(`[STEPTOWARD] Target (${to.x},${to.y}) walkable: ${isWalkable}`);
    
    if (!isWalkable) {
        console.warn(`[STEPTOWARD] ✗ Target (${to.x},${to.y}) is NOT walkable!`);
        return 'stuck';
    }
    
    const rightTileX = Math.round(agent.x) + 1;
    const rightTileY = Math.round(agent.y);
    const rightKey = `${rightTileX},${rightTileY}`;
    const rightTile = agent.beliefs.map.tiles.get(rightKey);
    console.log(`[STEPTOWARD] Tile to the right (${rightKey}):`, rightTile ? `type=${rightTile.type}` : 'NO TILE');
    console.log(`[STEPTOWARD] Is right tile walkable? ${agent.beliefs.map.walkable.has(rightKey)}`);
    
    console.log(`[STEPTOWARD] All tiles around (${Math.round(agent.x)},${Math.round(agent.y)}):`);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const key = `${Math.round(agent.x) + dx},${Math.round(agent.y) + dy}`;
            const tile = agent.beliefs.map.tiles.get(key);
            if (tile) {
                console.log(`  (${tile.x},${tile.y}) type=${tile.type} walkable=${agent.beliefs.map.walkable.has(key)}`);
            } else {
                console.log(`  (${Math.round(agent.x) + dx},${Math.round(agent.y) + dy}) NO TILE DEFINED`);
            }
        }
    }
    
    const forbidden = agent.beliefs.missionConstraints?.forbiddenTiles ?? new Set();
    const path = computePath(
        { x: agent.x, y: agent.y },
        target,
        agent.beliefs.map.walkable,
        agent.beliefs.map.exitDirs,
        agent.beliefs.agents,
        forbidden
    );

    if (path === null) {
        console.warn(`[PATHFIND] ✗ No path from (${Math.round(agent.x)},${Math.round(agent.y)}) to (${target.x},${target.y})`);
        return 'stuck';
    }
    if (path.length === 0) {
        console.log(`[PATHFIND] ✓ Already at target (${target.x},${target.y})`);
        return 'arrived';
    }

    const nextMove = path[0];
    console.log(`[PATHFIND] Path: [${path.slice(0, 5).join(',')}${path.length > 5 ? '...' : ''}] (${path.length} steps) → next move: ${nextMove}`);
    
    let newX = Math.round(agent.x);
    let newY = Math.round(agent.y);
    switch(nextMove) {
        case 'right': newX++; break;
        case 'left': newX--; break;
        case 'up': newY++; break;
        case 'down': newY--; break;
    }
    const nextTileKey = `${newX},${newY}`;
    const nextTileWalkable = agent.beliefs.map.walkable.has(nextTileKey);
    console.log(`[STEPTOWARD] Next tile (${nextTileKey}) walkable: ${nextTileWalkable}`);
    
    if (!nextTileWalkable) {
        console.warn(`[STEPTOWARD] ✗ Next move ${nextMove} leads to NON-walkable tile ${nextTileKey}!`);
        return 'stuck';
    }
    
    const result = await agent.socket.emitMove(nextMove);
    if (result === false) {
        console.warn(`[MOVE] ✗ Move ${nextMove} failed at (${Math.round(agent.x)},${Math.round(agent.y)})`);
        return 'stuck';
    }

    const oldPos = `(${Math.round(agent.x)},${Math.round(agent.y)})`;
    agent.x = result.x;
    agent.y = result.y;
    const newPos = `(${Math.round(agent.x)},${Math.round(agent.y)})`;

    console.log(`[MOVE] ✓ ${nextMove}: ${oldPos} → ${newPos}`);

    if (Math.round(agent.x) === target.x && Math.round(agent.y) === target.y) return 'arrived';
    return 'moved';
}
export { generateOptions, filterIntentions, bfsDist, distToNearestDelivery, computePath, go_to, stepToward };
