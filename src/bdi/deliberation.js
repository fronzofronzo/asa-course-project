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
 * Validate a planned PDDL step against current beliefs, driven by the step's declared
 * action (not by guessing from beliefs). A PDDL plan provably reaches the goal, so the
 * only thing that can break it is the live world having drifted from the solve snapshot.
 * Returns true if the step's preconditions still hold and it can be emitted now.
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
    // reward cap is enforced at delivery (hold-and-decay), not at pickup — over-cap parcels are collectable

    const stepsToParcel = bfsDist(agentPos, parcel, walkable);
    if (stepsToParcel === Infinity) return -Infinity;

    const stepsToDelivery = distToNearestDelivery(parcel, deliveryTiles, walkable);
    if (stepsToDelivery === Infinity) return -Infinity;

    // gameReward: actual reward the server will give if we reach the parcel now
    const stepsSinceLastSeen = (Date.now() - parcel.lastSeen) / 1000;
    const gameReward = Math.max(0, parcel.reward - decay * stepsSinceLastSeen);

    // deliverability: the reward decays while we walk to it AND on to a delivery tile.
    // If it would hit 0 before we can deliver, the parcel expires in transit (wasted trip) → never pick it.
    if (gameReward - decay * (stepsToParcel + stepsToDelivery) <= 0) return -Infinity;

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
    // Snap to the nearest tile: mid-move the server reports fractional coords (0.6/0.4 steps),
    // which bfsDist can't key into the walkable set → every parcel scores Infinity → empty
    // option list → intention cleared every other tick (ping-pong). Round before pathfinding.
    agentPos = { x: Math.round(agentPos.x), y: Math.round(agentPos.y) };
    const { deliveryTiles, walkable } = beliefs.map;
    const constraints = beliefs.missionConstraints ?? null;
    const effectiveDeliveryTiles = getEffectiveDeliveryTiles(deliveryTiles, constraints);
    const desires = [];

    // PICKUP desires — skip entirely if stack.max reached
    const atStackMax = constraints?.stack?.max !== null && constraints?.stack?.max !== undefined
        && carriedCount >= constraints.stack.max;
    const rewardCap = constraints?.rewardCap;
    const capActive = rewardCap?.cap != null;
    const now = Date.now();
    if (!atStackMax) {
        for (const parcel of beliefs.parcels.values()) {
            if (parcel.carriedBy !== null) continue;
            if (hardBlacklist?.has(parcel.id)) continue; // hard skip: handoff-dropped parcels
            // reward cap: gate pickup by mode (single/stack) using the parcel's live decayed reward
            let over = false;
            if (capActive) {
                const liveR = Math.max(0, parcel.reward - decay * (now - parcel.lastSeen) / 1000);
                if (!rewardCap.allowsAdditionalPickup(carriedReward, carriedCount, liveR)) continue;
                over = liveR > rewardCap.cap;
            }
            const utility = computeUtility(parcel, agentPos, carriedCount, effectiveDeliveryTiles, walkable, decay, beliefs.agents, constraints, unreachableParcels);
            if (utility > threshold) {
                // Rank against DELIVER on a marginal basis: while carrying, the load is delivered
                // either way, so a pickup's ranking value = carriedReward + its own standalone value.
                // Without this, DELIVER (≈carriedReward) always beats any pickup worth less than the
                // whole current load → the agent never tops up with cheap parcels on its route.
                // Threshold/deliverability still gated on the standalone `utility` above.
                const rankU = carriedCount > 0 && utility !== -Infinity ? utility + carriedReward : utility;
                desires.push({ type: 'PICKUP', id: parcel.id, parcel, utility: rankU, over });
            }
        }
    }

    // reward cap hybrid: if any sub-cap parcel is collectable, drop the over-cap ones
    // (expensive parcels are only chased as a fallback when nothing cheap is available)
    if (capActive && desires.some(d => d.type === 'PICKUP' && !d.over)) {
        for (let i = desires.length - 1; i >= 0; i--) {
            if (desires[i].type === 'PICKUP' && desires[i].over) desires.splice(i, 1);
        }
    }

    // DELIVER desire — first-class option whenever carrying & stack constraint satisfied.
    // It competes with PICKUP desires by utility + hysteresis (NOT gated on "no pickups visible").
    // Gating it on desires.length===0 made DELIVER vanish whenever any parcel — even a cheap one —
    // flickered into sensing range, flipping the agent between delivering and chasing → ping-pong
    // near the delivery zone. Always emitting it lets a stable DELIVER U arbitrate against pickups.
    if (carriedCount > 0) {
        const stackMin = constraints?.stack?.min ?? null;
        const stackReady = stackMin === null || carriedCount >= stackMin;
        if (stackReady) {
            const distDel = distToNearestDelivery(agentPos, effectiveDeliveryTiles, walkable);
            // unreachable delivery (Infinity) → -Infinity utility → ranked last, agent keeps collecting
            const utility = distDel === Infinity ? -Infinity : carriedReward - decay * distDel;
            desires.push({ type: 'DELIVER', id: 'DELIVER', utility });
        }
        // if !stackReady: no DELIVER → agent keeps collecting toward stack.min
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
                const failures = (agent._cratePlanFailures ??= new Map());

                // Backoff: don't re-run the ~9s online solve every cycle on a dead snapshot.
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

                // The online solver is slow (network). Solve once and cache the FULL plan
                // steps (action + cells), so we can validate each step by its declared
                // intent (MOVE vs PUSH) against live beliefs before emitting.
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

                // Drain the plan faithfully. A PDDL plan provably reaches the goal, so a
                // crate can never be left blocking us. The only failure mode is the live
                // world having drifted from the solve snapshot (e.g. a crate sensed mid-route
                // on a cell the plan assumed empty) → re-solve from the current position;
                // the fresh plan naturally pushes that crate aside.
                const moveDur = agent.gameConfig?.player?.movement_duration ?? 500;
                let replans = 0;
                let progressed = false;
                const yieldOrFail = () => {
                    if (progressed) return 'moved';        // made headway — BDI re-enters and continues
                    noteFailure();                          // stuck with no progress — arm backoff
                    return 'unreachable';
                };
                while (cache.steps.length > 0) {
                    const step = cache.steps[0];
                    const dir = actionToDirection(step);

                    // Step's planned precondition no longer holds in live beliefs → re-solve.
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
                            console.warn(`[PDDL] ${step.action} rejected by server, replan budget spent — yielding`);
                            return yieldOrFail();
                        }
                        console.warn(`[PDDL] ${step.action} rejected by server — re-solving from (${Math.round(agent.x)},${Math.round(agent.y)})`);
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
