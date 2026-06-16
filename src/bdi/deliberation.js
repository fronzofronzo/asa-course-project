import { bfsDist, getEffectiveDeliveryTiles } from './utils.js';
import { planCrateMove, actionToDirection } from './PDDL/pddl_planner.js';

// Exponential backoff for failed crate-push plans, keyed by goal "x,y".
// Stops the agent from re-running the ~9s online solve every cycle on an
// unsolvable snapshot (livelock). base 3s, doubling, capped at 30s.
const CRATE_BACKOFF_BASE_MS = 3000;
const CRATE_BACKOFF_CAP_MS = 30000;
const CRATE_MAX_INCALL_REPLANS = 2;

/** Parse a PDDL cell object name "c_8_4" into {x:8,y:4}. */
function parseCell(name) {
    const [, x, y] = String(name).toLowerCase().split('_');
    return { x: Number(x), y: Number(y) };
}

/**
 * Validate a planned PDDL step against current beliefs, driven by the step's declared action (not by guessing from beliefs). 
 */
function planStepValid(beliefs, step) {
    const a = String(step?.action ?? '').toLowerCase();
    const walkable = beliefs.map.walkable;
    const crates = beliefs.crateCells?.() ?? new Set();
    const pushTargets = beliefs.map.pushTargets ?? new Set();

    if (a.startsWith('move-')) {
        const d = parseCell(step.args[1]);
        const k = `${d.x},${d.y}`;
        return walkable.has(k) && !crates.has(k);
    }
    if (a.startsWith('push-')) {
        const c = parseCell(step.args[1]); // crate's current cell
        const d = parseCell(step.args[2]); // crate's destination
        const ck = `${c.x},${c.y}`;
        const dk = `${d.x},${d.y}`;
        return crates.has(ck) && walkable.has(dk) && pushTargets.has(dk) && !crates.has(dk);
    }
    return false;
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


const BELIEF_THRESHOLD = 0.1;
const UNREACHABLE_PENALTY_BASE = 100;
const UNREACHABLE_PENALTY_TAU  = 5; 
/**
* Compute utility of picking up a parcel, considering:
* - Belief score (uncertainty about parcel's existence)
* - Steps to parcel and delivery (accessibility)
* - Decayed reward (time-sensitive value)
* - Detour cost if carrying other parcels (stacking constraints)
* - Penalty for parcels marked unreachable (with decay over time)
* Returns -Infinity if pickup is not viable under current beliefs and constraints.
* @param {object} parcel  parcel belief object
* @param {{ x:number, y:number }} agentPos  current agent position
* @param {number} carriedCount  how many parcels currently carried (for stacking cost)
* @param {{ x:number, y:number }[]} deliveryTiles  available delivery locations
* @param {Set<string>} walkable  set of "x,y" walkable keys for pathfinding
* @param {number} decay  reward decay per second
* @param {Map<string, object>} otherAgents  belief agents (for accessibility checks)
* @param {object|null} constraints  mission constraints (for accessibility checks)
* @param {Map<string, number>|null} unreachableParcels  optional map of parcelId → timestamp when marked unreachable (for penalty)
 */
function computeUtility(parcel, agentPos, carriedCount, deliveryTiles, walkable, decay, otherAgents = new Map(), constraints = null, unreachableParcels = null) {
    if ((parcel.beliefScore ?? 1.0) < BELIEF_THRESHOLD) return -Infinity;

    const stepsToParcel = bfsDist(agentPos, parcel, walkable);
    if (stepsToParcel === Infinity) return -Infinity;

    const stepsToDelivery = distToNearestDelivery(parcel, deliveryTiles, walkable);
    if (stepsToDelivery === Infinity) return -Infinity;
    const stepsSinceLastSeen = (Date.now() - parcel.lastSeen) / 1000;
    const gameReward = Math.max(0, parcel.reward - decay * stepsSinceLastSeen);

    if (gameReward - decay * (stepsToParcel + stepsToDelivery) <= 0) return -Infinity;
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
 * @param {Map<string, number>|null} unreachableParcels  optional map of parcelId → timestamp when marked unreachable (for penalty)
 * @param {Set<string>|null} hardBlacklist  optional set of parcelIds to exclude from desires (e.g. recently failed pickups)
 * @return {{ type:string, id:string, utility:number, parcel?:object, tile?:object, over?:boolean }[]} desires sorted by utility desc
 */
function generateOptions(beliefs, agentPos, carriedCount, carriedReward, decay, threshold, unreachableParcels = null, hardBlacklist = null) {
    agentPos = { x: Math.round(agentPos.x), y: Math.round(agentPos.y) };
    const { deliveryTiles, walkable } = beliefs.map;
    const constraints = beliefs.missionConstraints ?? null;
    const effectiveDeliveryTiles = getEffectiveDeliveryTiles(deliveryTiles, constraints);
    const desires = [];

    const atStackMax = constraints?.stack?.max !== null 
    && constraints?.stack?.max !== undefined
    && carriedCount >= constraints.stack.max;
    const rewardCap = constraints?.rewardCap;
    const capActive = rewardCap?.cap != null;
    const now = Date.now();
    if (!atStackMax) {
        for (const parcel of beliefs.parcels.values()) {
            if (parcel.carriedBy !== null) continue;
            if (hardBlacklist?.has(parcel.id)) continue; 
            let over = false;
            if (capActive) {
                const liveR = Math.max(0, parcel.reward - decay * (now - parcel.lastSeen) / 1000);
                if (!rewardCap.allowsAdditionalPickup(carriedReward, carriedCount, liveR)) continue;
                over = liveR > rewardCap.cap;
            }
            const utility = computeUtility(parcel, agentPos, carriedCount, effectiveDeliveryTiles, walkable, decay, beliefs.agents, constraints, unreachableParcels);
            if (utility > threshold) {
                const rankU = carriedCount > 0 && utility !== -Infinity ? utility + carriedReward : utility;
                desires.push({ type: 'PICKUP', id: parcel.id, parcel, utility: rankU, over });
            }
        }
    }

    if (capActive && desires.some(d => d.type === 'PICKUP' && !d.over)) {
        for (let i = desires.length - 1; i >= 0; i--) {
            if (desires[i].type === 'PICKUP' && desires[i].over) desires.splice(i, 1);
        }
    }
    if (carriedCount > 0) {
        const stackMin = constraints?.stack?.min ?? null;
        const stackReady = stackMin === null || carriedCount >= stackMin;
        if (stackReady) {
            const distDel = distToNearestDelivery(agentPos, effectiveDeliveryTiles, walkable);
            // unreachable delivery (Infinity) → -Infinity utility → ranked last, agent keeps collecting
            const utility = distDel === Infinity ? -Infinity : carriedReward - decay * distDel;
            desires.push({ type: 'DELIVER', id: 'DELIVER', utility });
        }
    }

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
        return false;
    }
    while (true) {
        if (agent.beliefs.missionConstraints?.isMovementFrozen?.()) {
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
            return false;
        }
        if (path.length === 0) return true;

        let result;
        try {
            result = await agent.socket.emitMove(path[0]);
        } catch (e) {
            continue;
        }
        if (result === false) {
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
        return 'stuck';
    }
    const from = { x: agent.x, y: agent.y };
    const to = target;
    
    const targetKey = `${to.x},${to.y}`;
    const isWalkable = agent.beliefs.map.walkable.has(targetKey);
    
    if (!isWalkable) {
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
        // a crate stands in the way → ask the PDDL planner to push it 
        if (crateCells.size > 0) {
            const pathNoCrates = computePath(
                { x: agent.x, y: agent.y }, target,
                agent.beliefs.map.walkable, agent.beliefs.map.exitDirs,
                agent.beliefs.agents, forbidden /* no crates */
            );
            if (pathNoCrates !== null) {
                const goalKey = `${target.x},${target.y}`;
                const failures = (agent._cratePlanFailures ??= new Map());

                const back = failures.get(goalKey);
                if (back && Date.now() < back.until && (!agent._cratePlan || agent._cratePlan.goalKey !== goalKey)) {
                    console.warn(`[PDDL] backoff ${goalKey} (${Math.ceil((back.until - Date.now()) / 1000)}s left) — skipping solve`);
                    return 'unreachable';
                }

                const noteFailure = () => {
                    const prev = failures.get(goalKey) ?? { count: 0 };
                    const count = prev.count + 1;
                    const wait = Math.min(CRATE_BACKOFF_BASE_MS * 2 ** (count - 1), CRATE_BACKOFF_CAP_MS);
                    failures.set(goalKey, { count, until: Date.now() + wait });
                };

                const solveFromHere = async () => {
                    console.log(`[PDDL] crate blocks path to (${target.x},${target.y}) — planning push from (${Math.round(agent.x)},${Math.round(agent.y)})`);
                    const plan = await planCrateMove(agent.beliefs, { x: agent.x, y: agent.y }, target);
                    const steps = (plan ?? []).filter(s => actionToDirection(s));
                    if (steps.length === 0) return null;
                    const c = agent._cratePlan = { goalKey, steps };
                    const preview = steps.slice(0, 8).map(actionToDirection).join(',');
                    console.log(`[PDDL] plan cached (${steps.length} steps): [${preview}${steps.length > 8 ? '...' : ''}]`);
                    return c;
                };

                let cache = agent._cratePlan;
                if (!cache || cache.goalKey !== goalKey || cache.steps.length === 0) {
                    cache = await solveFromHere();
                    if (!cache) {
                        agent._cratePlan = null;
                        noteFailure();
                        console.warn(`[PDDL] no push plan — ✗ No path from (${Math.round(agent.x)},${Math.round(agent.y)}) to (${target.x},${target.y})`);
                        return 'unreachable';
                    }
                }

                const moveDur = agent.gameConfig?.player?.movement_duration ?? 500;
                let replans = 0;
                let progressed = false;
                const yieldOrFail = () => {
                    if (progressed) return 'moved';        
                    noteFailure();                          
                    return 'unreachable';
                };
                while (cache.steps.length > 0) {
                    const step = cache.steps[0];
                    const dir = actionToDirection(step);

                    if (!planStepValid(agent.beliefs, step)) {
                        agent._cratePlan = null;
                        if (replans++ >= CRATE_MAX_INCALL_REPLANS) {
                            console.warn(`[PDDL] step ${step.action} diverged, replan budget spent — yielding`);
                            return yieldOrFail();
                        }
                        console.warn(`[PDDL] step ${step.action} diverged from beliefs — re-solving from (${Math.round(agent.x)},${Math.round(agent.y)})`);
                        cache = await solveFromHere();
                        if (!cache) return yieldOrFail();
                        continue;
                    }

                    let result;
                    try {
                        result = await agent.socket.emitMove(dir);
                    } catch (e) {
                        console.warn(`[PDDL] move ${dir} threw: ${e.message}`);
                        result = false;
                    }
                    if (result === false) {
                        agent._cratePlan = null;
                        if (replans++ >= CRATE_MAX_INCALL_REPLANS) {
                            return yieldOrFail();
                        }
                        cache = await solveFromHere();
                        if (!cache) return yieldOrFail();
                        continue;
                    }
                    cache.steps.shift();
                    agent.x = result.x;
                    agent.y = result.y;
                    progressed = true;
                    if (cache.steps.length > 0) await new Promise(r => setTimeout(r, moveDur));
                }
                agent._cratePlan = null;
                failures.delete(goalKey); // plan fully executed — clear backoff
                if (Math.round(agent.x) === target.x && Math.round(agent.y) === target.y) return 'arrived';
                return 'moved';
            }
        }
        console.warn(`[PATHFIND] ✗ No path from (${Math.round(agent.x)},${Math.round(agent.y)}) to (${target.x},${target.y})`);
        return 'unreachable';
    }
    if (agent._cratePlan) agent._cratePlan = null;

    const nextMove = path[0];
    
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
    
    if (!nextTileWalkable) {
        return 'stuck';
    }
    
    let result;
    try {
        result = await agent.socket.emitMove(nextMove);
    } catch (e) {
        return 'stuck';
    }
    if (result === false) {
        return 'stuck';
    }

    agent.x = result.x;
    agent.y = result.y;

    if (Math.round(agent.x) === target.x && Math.round(agent.y) === target.y) return 'arrived';
    return 'moved';
}
export { generateOptions, filterIntentions, bfsDist, distToNearestDelivery, computePath, go_to, stepToward };
