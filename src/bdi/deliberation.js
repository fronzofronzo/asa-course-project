import { bfsDist, getEffectiveDeliveryTiles } from './utils.js';
import { planCrateMove, actionToDirection } from './PDDL/pddl_planner.js';

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

const UNREACHABLE_PENALTY_BASE = 100;
const UNREACHABLE_PENALTY_TAU  = 5; // seconds — penalty halves every ~3.5s, ~0 after ~20s

function computeUtility(parcel, agentPos, carriedCount, deliveryTiles, walkable, decay, otherAgents = new Map(), constraints = null, unreachableParcels = null) {
    // parcel with low belief score is probably gone — skip immediately
    if ((parcel.beliefScore ?? 1.0) < BELIEF_THRESHOLD) return -Infinity;
    // skip parcels exceeding reward cap
    if (constraints?.rewardCap.cap !== null && parcel.reward > constraints.rewardCap.cap) return -Infinity;

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

    let utility = effectiveReward
        - decay * (stepsToParcel + stepsToDelivery)
        - decay * carriedCount * detoursSteps;

    if (unreachableParcels) {
        const markedAt = unreachableParcels.get(parcel.id);
        if (markedAt !== undefined) {
            const elapsed = (Date.now() - markedAt) / 1000;
            const penalty = UNREACHABLE_PENALTY_BASE * Math.exp(-elapsed / UNREACHABLE_PENALTY_TAU);
            utility -= penalty;
        }
    }

    return utility;
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
function generateOptions(beliefs, agentPos, carriedCount, carriedReward, decay, threshold, unreachableParcels = null, hardBlacklist = null) {
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
            if (hardBlacklist?.has(parcel.id)) continue; // hard skip: handoff-dropped parcels
            const utility = computeUtility(parcel, agentPos, carriedCount, effectiveDeliveryTiles, walkable, decay, beliefs.agents, constraints, unreachableParcels);
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
function computePath(from, to, walkable, exitDirs, knownAgents, forbiddenTiles = new Set(), crateCells = new Set()) {
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
    for (const key of crateCells) blocked.add(key); // crates block A*; PDDL fallback pushes them
    blocked.delete(goalKey);
    if (blocked.size > 0) {
        console.log(`[PATHFIND] ${blocked.size} tile(s) blocking (agents + forbidden + crates)`);
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
    if (agent.beliefs.missionConstraints?.isMovementFrozen?.()) {
        console.warn('[go_to] Movement frozen (red light) — aborting navigation');
        return false;
    }
    while (true) {
        if (agent.beliefs.missionConstraints?.isMovementFrozen?.()) {
            console.warn('[go_to] Movement frozen mid-path (red light) — stopping');
            return false;
        }
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

        let result;
        try {
            result = await agent.socket.emitMove(path[0]);
        } catch (e) {
            console.warn(`go_to: move ${path[0]} threw: ${e.message} — replanning`);
            continue;
        }
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
    if (agent.beliefs.missionConstraints?.isMovementFrozen?.()) {
        console.warn('[stepToward] Movement frozen (red light) — aborting step');
        return 'stuck';
    }
    const from = { x: agent.x, y: agent.y };
    const to = target;
    
    const targetKey = `${to.x},${to.y}`;
    const isWalkable = agent.beliefs.map.walkable.has(targetKey);
    console.log(`[STEPTOWARD] Target (${to.x},${to.y}) walkable: ${isWalkable}`);
    
    if (!isWalkable) {
        console.warn(`[STEPTOWARD] ✗ Target (${to.x},${to.y}) is NOT walkable!`);
        return 'stuck';
    }
    
    const forbidden = agent.beliefs.missionConstraints?.forbidden.tiles ?? new Set();
    const crateCells = agent.beliefs.crateCells?.() ?? new Set();
    const path = computePath(
        { x: agent.x, y: agent.y },
        target,
        agent.beliefs.map.walkable,
        agent.beliefs.map.exitDirs,
        agent.beliefs.agents,
        forbidden,
        crateCells
    );

    if (path === null) {
        // A* failed. Is a crate the blocker? If a path exists when we ignore crates,
        // a crate stands in the way → ask the PDDL planner to push it (Sokoban-style).
        if (crateCells.size > 0) {
            const pathNoCrates = computePath(
                { x: agent.x, y: agent.y }, target,
                agent.beliefs.map.walkable, agent.beliefs.map.exitDirs,
                agent.beliefs.agents, forbidden /* no crates */
            );
            if (pathNoCrates !== null) {
                const goalKey = `${target.x},${target.y}`;
                // The online solver is slow (network). Solve ONCE per crate situation and
                // cache the move/push sequence; execute it step by step without re-solving.
                let cache = agent._cratePlan;
                if (!cache || cache.goalKey !== goalKey || cache.dirs.length === 0) {
                    console.log(`[PDDL] crate blocks path to (${target.x},${target.y}) — planning push`);
                    const plan = await planCrateMove(agent.beliefs, { x: agent.x, y: agent.y }, target);
                    const dirs = (plan ?? []).map(actionToDirection).filter(Boolean);
                    if (dirs.length === 0) {
                        agent._cratePlan = null;
                        console.warn(`[PDDL] no push plan — ✗ No path from (${Math.round(agent.x)},${Math.round(agent.y)}) to (${target.x},${target.y})`);
                        return 'unreachable';
                    }
                    cache = agent._cratePlan = { goalKey, dirs };
                    console.log(`[PDDL] plan cached (${dirs.length} steps): [${dirs.slice(0, 8).join(',')}${dirs.length > 8 ? '...' : ''}]`);
                }
                // Drain the whole push plan in one commit. Pace by movement_duration so the
                // moves don't outrun the server (drift).
                console.log(`[PDDL] executing cached plan (${cache.dirs.length} steps)`);
                const moveDur = agent.gameConfig?.player?.movement_duration ?? 500;
                while (cache.dirs.length > 0) {
                    const dir = cache.dirs[0];
                    let result;
                    try {
                        result = await agent.socket.emitMove(dir);
                    } catch (e) {
                        agent._cratePlan = null;
                        console.warn(`[PDDL] move ${dir} threw: ${e.message} — invalidating plan`);
                        return 'stuck';
                    }
                    if (result === false) {
                        agent._cratePlan = null;
                        console.warn(`[PDDL] push/move ${dir} failed — invalidating plan`);
                        return 'stuck';
                    }
                    cache.dirs.shift();
                    agent.x = result.x;
                    agent.y = result.y;
                    if (cache.dirs.length > 0) await new Promise(r => setTimeout(r, moveDur));
                }
                agent._cratePlan = null;
                if (Math.round(agent.x) === target.x && Math.round(agent.y) === target.y) return 'arrived';
                return 'moved';
            }
        }
        console.warn(`[PATHFIND] ✗ No path from (${Math.round(agent.x)},${Math.round(agent.y)}) to (${target.x},${target.y})`);
        return 'unreachable';
    }
    // Normal A* path available → no crate blocking; drop any stale push plan.
    if (agent._cratePlan) agent._cratePlan = null;
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
    
    let result;
    try {
        result = await agent.socket.emitMove(nextMove);
    } catch (e) {
        console.warn(`[MOVE] ✗ ${nextMove} threw: ${e.message} — treating as stuck`);
        return 'stuck';
    }
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
