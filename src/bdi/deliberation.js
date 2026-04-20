/**
 * BFS shortest-path distance on the walkability graph.
 * Returns Infinity if unreachable.
 * @param {{ x:number, y:number }} from
 * @param {{ x:number, y:number }} to
 * @param {Set<string>} walkable
 * @returns {number}
 */
function bfsDist(from, to, walkable) {
    const goal = `${to.x},${to.y}`;
    const start = `${from.x},${from.y}`;
    if (start === goal) return 0;
    if (!walkable.has(start) || !walkable.has(goal)) return Infinity;

    const queue = [[from.x, from.y, 0]];
    const visited = new Set([start]);
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];

    while (queue.length) {
        const [x, y, d] = queue.shift();
        for (const [dx, dy] of dirs) {
            const nx = x + dx, ny = y + dy;
            const key = `${nx},${ny}`;
            if (key === goal) return d + 1;
            if (!visited.has(key) && walkable.has(key)) {
                visited.add(key);
                queue.push([nx, ny, d + 1]);
            }
        }
    }
    return Infinity;
}

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
 * U(p) = reward(p) - decay*steps_to_p - decay*steps_to_delivery(p) - decay*steps_to_p*carried_count
 * @param {{ x:number, y:number, reward:number }} parcel
 * @param {{ x:number, y:number }} agentPos
 * @param {number} carriedCount
 * @param {{ x:number, y:number }[]} deliveryTiles
 * @param {Set<string>} walkable
 * @param {number} decay
 * @returns {number}
 */
function computeUtility(parcel, agentPos, carriedCount, deliveryTiles, walkable, decay) {
    const stepsToParcel = bfsDist(agentPos, parcel, walkable);
    if (stepsToParcel === Infinity) return -Infinity;

    const stepsToDelivery = distToNearestDelivery(parcel, deliveryTiles, walkable);
    if (stepsToDelivery === Infinity) return -Infinity;

    return parcel.reward
        - decay * stepsToParcel
        - decay * stepsToDelivery
        - decay * stepsToParcel * carriedCount;
}

/**
 * Generate desires: scored parcel options above threshold, sorted by utility desc.
 * @param {import('./belief.js').BeliefSet} beliefs
 * @param {{ x:number, y:number }} agentPos
 * @param {number} carriedCount
 * @param {number} decay
 * @param {number} threshold
 * @returns {{ parcel: object, utility: number }[]}
 */
function generateOptions(beliefs, agentPos, carriedCount, decay, threshold) {
    const { deliveryTiles, walkable } = beliefs.map;
    const desires = [];

    for (const parcel of beliefs.parcels.values()) {
        if (parcel.carriedBy !== null) continue; // already held by someone
        const utility = computeUtility(parcel, agentPos, carriedCount, deliveryTiles, walkable, decay);
        if (utility > threshold) {
            desires.push({ parcel, utility });
        }
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
    const currentStillValid = desires.find(d => d.parcel.id === currentIntention.parcel.id);
    if (!currentStillValid) return best;

    // only switch if significantly better
    if (best.utility > currentStillValid.utility + epsilon) return best;

    return currentStillValid;
}

/**
 * A* on walkability graph. Returns ordered direction list or null if unreachable.
 * @param {{ x:number, y:number }} from  agent current position (may be fractional)
 * @param {{ x:number, y:number }} to    target tile
 * @param {Set<string>} walkable
 * @param {Map<string, object>} knownAgents  belief agents (their tiles are avoided)
 * @returns {string[] | null}
 */
function computePath(from, to, walkable, knownAgents) {
    const sx = Math.round(from.x), sy = Math.round(from.y);
    const gx = to.x, gy = to.y;
    const startKey = `${sx},${sy}`;
    const goalKey  = `${gx},${gy}`;

    if (startKey === goalKey) return [];
    if (!walkable.has(goalKey)) return null;

    const blocked = new Set(
        [...knownAgents.values()].map(a => `${Math.round(a.x)},${Math.round(a.y)}`)
    );
    blocked.delete(startKey); // never block start

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

        if (key === goalKey) return path;
        if ((visited.get(key) ?? Infinity) <= g) continue;
        visited.set(key, g);

        for (const { dx, dy, dir } of dirs) {
            const nx = x + dx, ny = y + dy;
            const nkey = `${nx},${ny}`;
            if (!walkable.has(nkey) || blocked.has(nkey)) continue;
            const ng = g + 1;
            if ((visited.get(nkey) ?? Infinity) <= ng) continue;
            open.push([ng + h(nx, ny), ng, nx, ny, [...path, dir]]);
        }
    }
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

export { generateOptions, filterIntentions, bfsDist, distToNearestDelivery, computePath, go_to };
