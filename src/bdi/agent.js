import 'dotenv/config'
import { BeliefSet } from './belief.js';
import { generateOptions, filterIntentions } from './deliberation.js';
import { nearestWalkableWithin } from './utils.js';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { interpretMission } from './llm/mission_interpreter.js';
import { log, setLoggerName, logOptions } from './logger.js';
import { plans } from './plans/index.js';


const DECAY = parseFloat(process.env.DECAY_RATE) || 0.1;
const UTILITY_THRESHOLD = parseFloat(process.env.UTILITY_THRESHOLD) || 0;
const INTENTION_EPSILON = parseFloat(process.env.INTENTION_EPSILON) || 5;
const DELIBERATION_INTERVAL = parseInt(process.env.DELIBERATION_INTERVAL) || 500; 
const RENDEZVOUS_DWELL_MS = parseInt(process.env.RENDEZVOUS_DWELL_MS) || 3000;

const PEER_AGENT_NAME = process.env.PEER_AGENT_NAME ?? null;
const AGENT_ROLE     = process.env.AGENT_ROLE ?? 'master'; // 'master' | 'slave'
let peerAgentId = process.env.PEER_AGENT_ID ?? null; // updated live when peer messages arrive

/**
 * Agent implementing a BDI (Belief-Desire-Intention) architecture for autonomous
 * parcel delivery in the Deliveroo.js game environment.
 *
 * The agent operates in a continuous loop: sense the world state (parcels, agents, map), deliberate on the best parcel to target, and execute one action per iteration
 * (move, pick up, or put down).
 *
 * The agent can operate as either 'master' (orchestrates cooperative missions)
 * or 'slave' (executes locally-relevant coordination directives from master).
 */
class Agent {
    constructor() {
        this.beliefs = new BeliefSet();
        this.id = null;
        this.name = null;
        this.score = 0;
        this.x = null;
        this.y = null;
        this.socket = new DjsConnect();
        this.intention = null;       
        this.carriedParcels = [];    
        this.stuckCount = 0;
        this.gameConfig = null;      
        this.gameStats = {
            startTime: Date.now(),
            avgReward: 10.0,     // overwritten from config on connect
            lastScore: 0,
            deliveries: [],      
        };

        /** Flag to trigger deliberation on next loop iteration */
        this.needsDeliberation = false;
        this.lastDeliberationTime = 0;
    }

    /** Mark that a belief update has occurred. */
    _notifyBeliefChanged() {
        this.needsDeliberation = true;
    }

    /** Check if enough time has passed since last deliberation. */
    shouldDeliberate() {
        const now = Date.now();
        return this.needsDeliberation || (now - this.lastDeliberationTime >= DELIBERATION_INTERVAL);
    }

    /** Record that deliberation just happened. */
    recordDeliberation() {
        this.needsDeliberation = false;
        this.lastDeliberationTime = Date.now();
    }

    /**
     * @param {string} id
     * @param {string} name
     * @param {number} x
     * @param {number} y
     * @param {number} score
     */
    updateInformation(id,name,x,y,score) {
        this.id = id;
        this.name = name;
        this.x = x;
        this.y = y;
        this.score = score;
    }
}
// Creating new Agent
const agent = new Agent();
agent.socket.onMap((width, height, tiles) => {
    agent.beliefs.updateMap(width, height, tiles);
})
agent.socket.onConfig((config) => {
    agent.gameConfig = config.GAME ?? null;
    if (config.GAME?.parcels?.reward_avg != null) {
        agent.gameStats.avgReward = config.GAME.parcels.reward_avg;
        console.log(`[CONFIG] avgReward from server: ${agent.gameStats.avgReward}`);
    }
})
agent.socket.onYou(({id, name, x, y, score}) => {
    setLoggerName(name);
    const delta = score - agent.gameStats.lastScore;
    if (delta > 0) {
        agent.gameStats.deliveries.push({ reward: delta, timestamp: Date.now() });
        if (agent.gameStats.deliveries.length > 20) agent.gameStats.deliveries.shift();
    }
    agent.gameStats.lastScore = score;
    agent.updateInformation(id, name, x, y, score);
})
agent.socket.onSensing(({ agents, parcels, crates }) => {
    agent.beliefs.updateBeliefs({ agents, parcels, crates });
    if (agent.x !== null) {
        agent.beliefs.updateParcelUncertainty({ x: agent.x, y: agent.y });
    }
    agent.carriedParcels = parcels.filter(p => p.carriedBy === agent.id);
    agent._notifyBeliefChanged();
});

async function safeEmit(fn, label) {
    try { return await fn(); } catch (e) {
        console.warn(`[${label}] socket timeout/error: ${e.message}`);
        return null;
    }
}

const visitedSpawns = new Map(); // key: "x,y" (spawn tile coords) → value: Date.now() of last visit
const unreachableDeliveryTiles = new Map(); // key: "x,y" (delivery tile coords) → value: Date.now() when marked unreachable
const unreachableParcels = new Map(); // key: parcel id (string) → value: Date.now() when marked unreachable
const handoffDropped = new Set(); // hard blacklist: parcels dropped by passer, not to be re-picked up until receiver gets them

const ctx = { visitedSpawns, unreachableDeliveryTiles, unreachableParcels, handoffDropped, safeEmit };


let llmBusy = false;
const pendingMissions = [];

/**
 * Processes queued missions one at a time, in FIFO order.
 *
 * Missions arrive via socket messages and are pushed onto `pendingMissions`.
 * This function drains that queue sequentially, ensuring only one LLM call
 * runs at a time (`llmBusy` guard). If called while already processing,
 * the loop condition exits immediately — the in-flight call will drain
 * remaining entries when it finishes.
 *
 * For each mission, calls `interpretMission` with:
 * - Current belief state and live agent position/score getters
 * - A reply callback to respond to the mission sender
 * - Live game stats (avg reward, delivery rate, capacity) for EV computation
 * - A coordination context object whose shape depends on `AGENT_ROLE`:
 *     - `master`: full context with `sendToPeer`, `getPeerAgentId`,
 *       `findNearestOddRowTile` — enables L3 coordination tools
 *     - `slave`: only `notifyBeliefChanged` — L3 master-only tools are no-ops
 *
 * `llmBusy` is always released in `finally`, even on LLM errors.
 */
async function drainMissions() {
    while (pendingMissions.length > 0 && !llmBusy) {
        const { name, msg, replyFn } = pendingMissions.shift();
        llmBusy = true;
        try {
            await interpretMission(
                name, msg, agent.beliefs,
                () => ({ x: agent.x, y: agent.y, score: agent.score }),
                replyFn,
                () => {
                    const elapsed = (Date.now() - agent.gameStats.startTime) / 1000;
                    const deliveries = agent.gameStats.deliveries;
                    const avgDeliveryReward = deliveries.length > 0
                        ? deliveries.reduce((s, d) => s + d.reward, 0) / deliveries.length
                        : agent.gameStats.avgReward;
                    return {
                        avgReward: agent.gameStats.avgReward,
                        avgDeliveryReward,
                        capacity: agent.gameConfig?.player?.capacity ?? 5,
                        movementDuration: agent.gameConfig?.player?.movement_duration ?? 500,
                        pointsPerSecond: agent.score / Math.max(1, elapsed),
                    };
                },
                // Master - slave coordination
                AGENT_ROLE === 'master'
                    ? {
                        sendToPeer: (msg) => sendToPeer(msg),
                        getPeerAgentId: () => peerAgentId,
                        findNearestOddRowTile: () => findNearestOddRowTile(),
                        notifyBeliefChanged: () => agent._notifyBeliefChanged(),
                    }
                    : { notifyBeliefChanged: () => agent._notifyBeliefChanged() },
                AGENT_ROLE
            );
        } finally {
            llmBusy = false;
        }
    }
}

const MISSION_SENDER = process.env.MISSION_SENDER ?? 'admin';

// ─── Coordination helpers ─────────────────────────────────────────────────────

/**
 * Finds the walkable tile on an odd row (y % 2 !== 0) closest to the agent.
 *
 * Used in L3 coordination missions (master role) to pick a rendezvous tile
 * on an odd row — a game-specific zone where the odd_row_wait mission requires
 * both agents to meet.
 *
 * Scans all walkable tiles in beliefs, filters by odd y, returns the one with
 * minimum Manhattan distance from the agent's current position.
 *
 * @returns {{ x: number, y: number } | null} Nearest odd-row tile, or null if
 *   walkable map is not yet initialized.
 */
function findNearestOddRowTile() {
    const walkable = agent.beliefs.map.walkable;
    if (!walkable) return null;
    let best = null, bestDist = Infinity;
    for (const key of walkable) {
        const [tx, ty] = key.split(',').map(Number);
        if (ty % 2 !== 0) {
            const dist = Math.abs(agent.x - tx) + Math.abs(agent.y - ty);
            if (dist < bestDist) { bestDist = dist; best = { x: tx, y: ty }; }
        }
    }
    return best;
}

/**
 * Sends a coordination message to the peer agent via the game's say channel.
 *
 * Serializes objects to JSON; strings are sent as-is. No-ops with a warning
 * if `peerAgentId` is not yet known (peer hasn't been seen on the map).
 *
 * `peerAgentId` is resolved lazily: set from `PEER_AGENT_ID` env var at startup,
 * or updated live when the peer's message arrives (see `socket.onMsg` handler).
 *
 * @param {object|string} msg - Coordination payload (e.g. `{ type: 'coord_cmd', ... }`).
 */
function sendToPeer(msg) {
    if (!peerAgentId) {
        console.warn('[COORD] Cannot send to peer: peerAgentId not known yet');
        return;
    }
    agent.socket.emitSay(peerAgentId, typeof msg === 'string' ? msg : JSON.stringify(msg));
}

/**
 * Dispatches incoming peer coordination messages. Updates `peerAgentId` lazily on first call.
 *
 * `coord_cmd` (master → slave): sets coordination state + injects tile utility 1000 to override BDI:
 *   - `meet_and_wait`        — setRendezvous, navigate to nearest walkable within maxDist
 *   - `parcel_handoff`       — setHandoff(role), await passer's `ready` status
 *   - `odd_row_wait`         — navigate to nearest odd-y tile, freeze until released
 *   - `release_coordination` — reset coordination + redLight, resume normal play
 *
 * `coord_status` (slave → master or peer progress):
 *   - `ready`   — passer frozen at pos → receiver navigates there
 *   - `dropped` — passer dropped parcel → receiver clears handoff, picks up
 *   - `arrived` — marks peerArrived on rendezvous; logged for oddRowWait
 *
 * `coord_ack`: logged only.
 *
 * @param {string} senderId - Socket ID of the peer agent.
 * @param {string} msg      - Raw JSON coordination message.
 */
function handleCoordinationMessage(senderId, msg) {
    peerAgentId = senderId; // track peer ID

    let parsed;
    try { parsed = JSON.parse(msg); } catch {
        console.log(`[COORD] Non-JSON peer message (ignoring): ${msg}`);
        return;
    }

    const coord = agent.beliefs.missionConstraints.coordination;

    if (parsed.type === 'coord_cmd') {
        const { mission, params = {} } = parsed;
        console.log(`\n[COORD] Command from peer: mission=${mission}`);

        if (mission === 'meet_and_wait') {
            const { x, y, maxDist = 3 } = params;
            coord.setRendezvous(x, y, maxDist);
            // The target tile may be non-walkable; navigate to the nearest walkable tile within maxDist.
            const goto = nearestWalkableWithin(agent.beliefs.map.walkable, x, y, maxDist) ?? { x: Math.round(x), y: Math.round(y) };
            agent.beliefs.tileUtilities.set(`${goto.x},${goto.y}`, 1000);
            agent.needsDeliberation = true;
            console.log(`[COORD] meet_and_wait: navigating to (${goto.x},${goto.y}) [target (${x},${y}) within dist ${maxDist}]`);
            sendToPeer({ type: 'coord_ack', mission, status: 'accepted' });

        } else if (mission === 'parcel_handoff') {
            const { role } = params;
            coord.setHandoff(role);
            // Receiver waits for 'ready' signal from passer before navigating
            console.log(`[COORD] parcel_handoff: role=${role} — waiting for passer position`);
            sendToPeer({ type: 'coord_ack', mission, status: 'accepted' });

        } else if (mission === 'odd_row_wait') {
            coord.setOddRowWait();
            const target = findNearestOddRowTile();
            if (target) {
                agent.beliefs.tileUtilities.set(`${target.x},${target.y}`, 1000);
                agent.needsDeliberation = true;
                console.log(`[COORD] odd_row_wait: navigating to odd row tile (${target.x},${target.y})`);
            } else {
                console.warn('[COORD] odd_row_wait: no odd-row tile found on map');
            }
            sendToPeer({ type: 'coord_ack', mission, status: 'accepted' });

        } else if (mission === 'release_coordination') {
            agent.beliefs.missionConstraints.redLight.set(false);
            agent.beliefs.missionConstraints.coordination.reset();
            console.log('[COORD] Coordination released by master — resuming normal play');

        } else {
            console.warn(`[COORD] Unknown coord_cmd mission: ${mission}`);
        }

    } else if (parsed.type === 'coord_status') {
        const { event } = parsed;
        if (event === 'ready' && coord.handoff?.role === 'receiver' && parsed.pos) {
            agent.beliefs.tileUtilities.set(`${Math.round(parsed.pos.x)},${Math.round(parsed.pos.y)}`, 1000);
            agent.needsDeliberation = true;
            console.log(`[COORD] Passer waiting at (${parsed.pos.x},${parsed.pos.y}) — navigating there`);
        } else if (event === 'dropped' && coord.handoff?.role === 'receiver') {
            coord.clearHandoff();
            if (parsed.tile) {
                agent.beliefs.tileUtilities.set(`${Math.round(parsed.tile.x)},${Math.round(parsed.tile.y)}`, 1000);
                agent.needsDeliberation = true;
            }
            console.log('[COORD] Peer dropped parcel — going to pick up');
        } else if (event === 'arrived' && coord.rendezvous) {
            coord.rendezvous.peerArrived = true;
            console.log('[COORD] Peer arrived at rendezvous');
        } else if (event === 'arrived' && coord.oddRowWait) {
            console.log('[COORD] Peer arrived at odd row');
        }

    } else if (parsed.type === 'coord_ack') {
        console.log(`[COORD] Peer ack: mission=${parsed.mission} status=${parsed.status}`);
    }
}

agent.socket.onMsg(async (senderId, name, msg, ack) => {
    // Peer agent message → coordination handler (no LLM)
    if (PEER_AGENT_NAME && name === PEER_AGENT_NAME) {
        handleCoordinationMessage(senderId, msg);
        if (ack) try { ack('ok'); } catch {}
        return;
    }
    // Check 'admin' is the mission sender.
    if (name !== MISSION_SENDER) {
        console.log(`[MISSION] Ignored message from ${name} (not ${MISSION_SENDER})`);
        if (ack) try { ack('ignored'); } catch {}
        return;
    }
    console.log(`\n[MISSION] (${AGENT_ROLE}) Message from ${name}: ${msg}`);
    // Works for both emitAsk (ack replies to caller) and emitSay (emitSay sends a new message)
    const replyFn = (message) => {
        if (ack) try { ack(message); } catch {}
        agent.socket.emitSay(senderId, message);
    };
    if (ack) try { ack(`${agent.name ?? 'agent'} received your message, evaluating...`); } catch {}
    pendingMissions.push({ name, msg, replyFn });
    if (!llmBusy) await drainMissions();
});

/**
 * Main BDI loop — runs continuously until process exit.
 *
 * Each iteration executes three phases in order:
 *
 * 1. **Deliberation** (rate-limited by DELIBERATION_INTERVAL or belief change flag):
 *    Calls `generateOptions` + `filterIntentions` to pick the best intention.
 *    survives if still valid and no better option exists.
 *
 * 2. **Coordination state checks** (before execution):
 *    - Rendezvous: freeze (redLight) when within `maxDist` of target; master releases both after dwell.
 *    - Odd-row wait: freeze when on any odd-y tile; signal peer.
 *    - Passer handoff: freeze in place, signal position to receiver, drop once receiver is visible.
 *
 * 3. **Execution** — delegates to the plan library (`plans/index.js`).
 *    Finds the first applicable plan via `plan.applicable(intention)` and calls `plan.execute(agent, ctx)`.
 *    Plans: DeliverPlan | PickupPlan | GotoPlan | ExplorePlan (fallback when intention is null).
 *    `ctx` carries shared execution state: visitedSpawns, unreachableDeliveryTiles,
 *    unreachableParcels, handoffDropped, safeEmit.
 *
 * Movement freeze: skips execution when `missionConstraints.isMovementFrozen()`.
 */
async function agentLoop() {
    console.log('Agent loop started — executing continuously with periodic deliberation...');

    while (true) {
        // Wait for agent position to be set
        if (agent.x === null) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }

        const agentPos = { x: agent.x, y: agent.y };
        const carriedCount = agent.carriedParcels.length;
        const carriedReward = agent.carriedParcels.reduce((sum, p) => sum + p.reward, 0);

        const desires = generateOptions(agent.beliefs, agentPos, carriedCount, carriedReward, DECAY, UTILITY_THRESHOLD, unreachableParcels, handoffDropped);

        // Log every option and its utility this iteration.
        logOptions(agentPos, desires, agent.intention?.id ?? null);

        // --- deliberation ---
        if (agent.shouldDeliberate() || agent.intention == null) {
            let newIntention = filterIntentions(desires, agent.intention, INTENTION_EPSILON);

            // Stick with Pickup intention if it's still valid and has higher utility than any new desire.
            if (agent.intention?.type === 'PICKUP'
                && agent.beliefs.parcels.has(agent.intention.id)
                && !desires.some(d => d.id === agent.intention.id)) {
                const heldU = agent.intention.utility;
                if (newIntention === null || newIntention.utility <= heldU + INTENTION_EPSILON) {
                    newIntention = agent.intention;
                }
            }

            if (newIntention?.id !== agent.intention?.id) {
                agent.intention = newIntention;
                agent.stuckCount = 0;
                if (newIntention) {
                    console.log(`[INTENTION] NEW: id=${newIntention.id} type=${newIntention.type} U=${newIntention.utility.toFixed(2)}`);
                } else {
                    console.log('[INTENTION] CLEARED: no viable desire');
                }
            } else if (agent.intention) {
                console.log(`[INTENTION] HELD: id=${agent.intention.id} type=${agent.intention.type} U=${agent.intention.utility.toFixed(2)}`);
            }
            agent.recordDeliberation();
        }

        // --- coordination state checks (before execution) ---
        {
            const coord = agent.beliefs.missionConstraints.coordination;
            const isStable = Number.isInteger(agent.x) && Number.isInteger(agent.y);

            // Rendezvous: freeze when within maxDist of target
            if (coord.rendezvous && !coord.rendezvous.selfArrived && isStable) {
                const r = coord.rendezvous;
                const dist = Math.abs(agent.x - r.x) + Math.abs(agent.y - r.y);
                if (dist <= r.maxDist) {
                    r.selfArrived = true;
                    agent.beliefs.missionConstraints.redLight.set(true);
                    sendToPeer({ type: 'coord_status', mission: 'meet_and_wait', event: 'arrived' });
                }
            }

            // Master rendez-vous handling.
            if (AGENT_ROLE === 'master' && coord.rendezvous && coord.rendezvous.selfArrived && coord.rendezvous.peerArrived) {
                const r = coord.rendezvous;
                if (!r.bothArrivedAt) {
                    r.bothArrivedAt = Date.now();
                } else if (Date.now() - r.bothArrivedAt >= RENDEZVOUS_DWELL_MS) {
                    sendToPeer({ type: 'coord_cmd', mission: 'release_coordination' });
                    agent.beliefs.missionConstraints.redLight.set(false);
                    agent.beliefs.missionConstraints.coordination.reset();
                    agent._notifyBeliefChanged();
                }
            }

            // Odd row: freeze when on any odd-y tile
            if (coord.oddRowWait && !coord.oddRowArrived && isStable && agent.y % 2 !== 0) {
                coord.oddRowArrived = true;
                agent.beliefs.missionConstraints.redLight.set(true);
                sendToPeer({ type: 'coord_status', mission: 'odd_row_wait', event: 'arrived' });
            }

            // Passer: once carrying a parcel, freeze in place and wait for receiver
            if (coord.handoff?.role === 'passer' && coord.handoff.state === 'pending' && carriedCount > 0 && isStable) {
                if (!coord.handoff.positionSent) {
                    coord.handoff.positionSent = true;
                    sendToPeer({ type: 'coord_status', mission: 'parcel_handoff', event: 'ready', pos: { x: agent.x, y: agent.y } });
                }
                const receiverVisible = [...agent.beliefs.agents.values()].some(a => a.id === peerAgentId || a.name === PEER_AGENT_NAME);
                if (receiverVisible) {
                    // Record IDs BEFORE drop — emitPutdown on non-delivery tile returns [] (not the parcels)
                    const toDrop = [...agent.carriedParcels];
                    await safeEmit(() => agent.socket.emitPutdown(), 'PUTDOWN');
                    // Hard-blacklist so passer never re-picks them up until receiver collects
                    for (const p of toDrop) handoffDropped.add(p.id);
                    setTimeout(() => { for (const p of toDrop) handoffDropped.delete(p.id); }, 60_000);
                    sendToPeer({ type: 'coord_status', mission: 'parcel_handoff', event: 'dropped', tile: { x: agent.x, y: agent.y } });
                    coord.clearHandoff();
                    agent._notifyBeliefChanged();
                } else {
                    await new Promise(r => setTimeout(r, 50));
                    continue; 
                }
            }
        }

        // Respect movement freeze (red light, coordination wait states)
        if (agent.beliefs.missionConstraints.isMovementFrozen()) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }

        // --- execution (continuous, one step per iteration) ---
        const plan = plans.find(p => p.applicable(agent.intention));
        if (plan) await plan.execute(agent, ctx);

        // Loop delay to avoid too fast movements in local.
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

agentLoop();

// Logging functions.

setInterval(() => {
    const c = agent.beliefs.missionConstraints;
    if (c.hasMission()) {
        log(`[MISSION_CONSTRAINTS] stack={min:${c.stack.min},max:${c.stack.max}} | preferredTiles=${c.preferred.tiles ? JSON.stringify(c.preferred.tiles) + `(x${c.preferred.multiplier})` : 'none'} | blacklist=[${[...c.blacklist.tiles].join(',')}] | rewardCap=${c.rewardCap.cap ?? 'none'} | forbidden=[${[...c.forbidden.tiles].join(',')}]`);
    } else {
        log('[MISSION_CONSTRAINTS] none active — standard play');
    }
}, 3000);
