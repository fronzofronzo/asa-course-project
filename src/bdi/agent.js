import 'dotenv/config'
import { BeliefSet } from './belief.js';
import { generateOptions, filterIntentions, stepToward } from './deliberation.js';
import { nearestDeliveryTile, computeBestSpawnTile } from './planner.js';
import { getEffectiveDeliveryTiles } from './utils.js';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { interpretMission } from './llm/mission_interpreter.js';
import { log, setLoggerName } from './logger.js';


const DECAY = parseFloat(process.env.DECAY_RATE) || 0.1;
const UTILITY_THRESHOLD = parseFloat(process.env.UTILITY_THRESHOLD) || 0;
const INTENTION_EPSILON = parseFloat(process.env.INTENTION_EPSILON) || 5;
const DELIBERATION_INTERVAL = parseInt(process.env.DELIBERATION_INTERVAL) || 500; // ms between re-deliberation

const PEER_AGENT_NAME = process.env.PEER_AGENT_NAME ?? null;
const AGENT_ROLE     = process.env.AGENT_ROLE ?? 'master'; // 'master' | 'slave'
let peerAgentId = process.env.PEER_AGENT_ID ?? null; // updated live when peer messages arrive

class Agent {
    constructor() {
        this.beliefs = new BeliefSet();
        this.id = null;
        this.name = null;
        this.score = 0;
        this.x = null;
        this.y = null;
        this.socket = new DjsConnect();
        this.intention = null;       // { parcel, utility } | null
        this.carriedParcels = [];    // parcels currently carried
        this.stuckCount = 0;
        this.gameConfig = null;      // populated by onConfig
        this.gameStats = {
            startTime: Date.now(),
            avgReward: 10.0,     // overwritten from config on connect
            lastScore: 0,
            deliveries: [],      // [{reward, timestamp}] rolling last-20
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
agent.socket.onSensing(({ agents, parcels }) => {
    agent.beliefs.updateBeliefs({ agents, parcels });
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

const visitedSpawns = new Map(); // key → timestamp of last visit
const unreachableDeliveryTiles = new Map(); // key of delivery tiles found to be unreachable
const unreachableParcels = new Map(); // parcelId → timestamp when marked unreachable (penalty decays over time)
const handoffDropped = new Set(); // hard blacklist: parcels dropped by passer, not to be re-picked up until receiver gets them

let llmBusy = false;
const pendingMissions = [];

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
                // master: full ctx (orchestrates L3); slave: no sendToPeer → L3 master-tools no-op, freeze stays local
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

function sendToPeer(msg) {
    if (!peerAgentId) {
        console.warn('[COORD] Cannot send to peer: peerAgentId not known yet');
        return;
    }
    agent.socket.emitSay(peerAgentId, typeof msg === 'string' ? msg : JSON.stringify(msg));
}

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
            agent.beliefs.tileUtilities.set(`${x},${y}`, 1000);
            agent.needsDeliberation = true;
            console.log(`[COORD] meet_and_wait: navigating to (${x},${y}) within dist ${maxDist}`);
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
            // Passer frozen in place with parcels — navigate to their position
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
    // Both roles interpret admin missions; slave defers L3 coordination to master (handled in LLM prompt)
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

async function agentLoop() {
    console.log('Agent loop started — executing continuously with periodic deliberation...');

    while (true) {
        // Wait for agent position to be set (first onYou callback)
        if (agent.x === null) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }

        const agentPos = { x: agent.x, y: agent.y };
        const carriedCount = agent.carriedParcels.length;
        const carriedReward = agent.carriedParcels.reduce((sum, p) => sum + p.reward, 0);

        // Always compute desires so shouldDeliver has accurate parcel count
        const desires = generateOptions(agent.beliefs, agentPos, carriedCount, carriedReward, DECAY, UTILITY_THRESHOLD, unreachableParcels, handoffDropped);

        // --- deliberation (periodic, on belief change, or when intention just cleared) ---
        if (agent.shouldDeliberate() || agent.intention == null) {
            console.log(`\n[DELIBERATION] at (${Math.round(agent.x)},${Math.round(agent.y)}) | carried=${carriedCount} reward=${carriedReward.toFixed(1)}`);
            console.log(`[DELIBERATION] Found ${desires.length} viable parcel(s)`);
            if (desires.length > 0) {
                console.log(`[DELIBERATION] Top 3: ${desires.slice(0, 3).map(d => `(${d.id} type=${d.type} U=${d.utility.toFixed(1)})`).join(' | ')}`);
            }

            const newIntention = filterIntentions(desires, agent.intention, INTENTION_EPSILON);

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
                    console.log(`[COORD] Arrived at rendezvous (${agent.x},${agent.y}) dist=${dist} — freezing`);
                }
            }

            // Odd row: freeze when on any odd-y tile
            if (coord.oddRowWait && !coord.oddRowArrived && isStable && agent.y % 2 !== 0) {
                coord.oddRowArrived = true;
                agent.beliefs.missionConstraints.redLight.set(true);
                sendToPeer({ type: 'coord_status', mission: 'odd_row_wait', event: 'arrived' });
                console.log(`[COORD] Arrived at odd row y=${agent.y} — freezing`);
            }

            // Passer: once carrying a parcel, freeze in place and wait for receiver
            if (coord.handoff?.role === 'passer' && coord.handoff.state === 'pending' && carriedCount > 0 && isStable) {
                if (!coord.handoff.positionSent) {
                    coord.handoff.positionSent = true;
                    sendToPeer({ type: 'coord_status', mission: 'parcel_handoff', event: 'ready', pos: { x: agent.x, y: agent.y } });
                    console.log(`[COORD] Passer frozen at (${agent.x},${agent.y}) with ${carriedCount} parcel(s) — waiting for receiver`);
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
                    console.log(`[COORD] Receiver in range — dropped ${toDrop.length} parcel(s) at (${agent.x},${agent.y})`);
                } else {
                    await new Promise(r => setTimeout(r, 50));
                    continue; // freeze: skip execution branches this iteration
                }
            }
        }

        // Respect movement freeze (red light, coordination wait states)
        if (agent.beliefs.missionConstraints.isMovementFrozen()) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }

        // --- execution (continuous, one step per iteration) ---
        if (agent.intention?.type === 'DELIVER') {
            console.log(`[EXECUTE] DELIVERY PHASE (carried=${carriedCount}, reward=${carriedReward.toFixed(1)})`);
            // Use blacklist/preferred-filtered tiles: never count a blacklisted tile as a valid drop spot
            const effectiveDelivery = getEffectiveDeliveryTiles(agent.beliefs.map.deliveryTiles, agent.beliefs.missionConstraints ?? null);
            const onDelivery = effectiveDelivery
                .some(t => t.x === Math.round(agent.x) && t.y === Math.round(agent.y));

            if (onDelivery) {
                const stackMin = agent.beliefs.missionConstraints?.stack?.min ?? null;
                if (stackMin !== null && carriedCount < stackMin) {
                    // stack not full — only deliver if no parcels left to collect (deadlock prevention)
                    const uncarriedExists = [...agent.beliefs.parcels.values()].some(p => p.carriedBy === null);
                    if (uncarriedExists) {
                        console.log(`[STACK] Carrying ${carriedCount}/${stackMin} min — aborting delivery, parcels still exist`);
                        agent.intention = null; // re-deliberate: find more parcels
                    } else {
                        await safeEmit(() => agent.socket.emitPutdown(), 'PUTDOWN');
                        console.log(`[STACK] Carrying ${carriedCount}/${stackMin} min — delivering anyway (no more parcels to collect)`);
                        agent.stuckCount = 0;
                        agent.intention = null;
                    }
                } else {
                    const dropped = await safeEmit(() => agent.socket.emitPutdown(), 'PUTDOWN');
                    console.log(`[EXECUTE] ✓ Delivered ${dropped?.length ?? 0} parcel(s) at (${Math.round(agent.x)},${Math.round(agent.y)})`);
                    agent.stuckCount = 0;
                    agent.intention = null;
                }
            } else {
                const target = nearestDeliveryTile(agent, unreachableDeliveryTiles);
                if (target) {
                    console.log(`[EXECUTE] Moving to delivery (${target.x},${target.y})`);
                    const status = await stepToward(target, agent);
                    console.log(`[EXECUTE] Move result: ${status} now at (${Math.round(agent.x)},${Math.round(agent.y)})`);
                    if (status === 'unreachable') {
                        // No path at all (e.g. forbidden/blocked destination): abandon this tile now, re-pick another
                        console.warn(`[UNREACHABLE] No path to delivery (${target.x},${target.y}) - marking unreachable, re-deliberating`);
                        unreachableDeliveryTiles.set(`${target.x},${target.y}`, Date.now());
                        agent.stuckCount = 0;
                        agent.needsDeliberation = true;
                    } else if (status === 'stuck') {
                        agent.stuckCount++;
                    }
                    if (agent.stuckCount > 5) {
                        console.warn(`[STUCK] Count=${agent.stuckCount} trying to reach delivery at (${target.x},${target.y}) - marking as unreachable`);
                        unreachableDeliveryTiles.set(`${target.x},${target.y}`, Date.now());
                        agent.stuckCount = 0;
                    }
                } else {
                    console.warn('[EXECUTE] ✗ No reachable delivery tile');
                }
            }

        } else if (agent.intention?.type === 'PICKUP') {
            const p = agent.intention.parcel;
            const onParcel = () => Number.isInteger(agent.x) && Number.isInteger(agent.y)
                && agent.x === p.x && agent.y === p.y;

            // Move toward the parcel if not already standing on it
            if (!onParcel()) {
                console.log(`[EXECUTE] Moving to parcel ${p.id} at (${p.x},${p.y}) (${Math.round(Math.sqrt((p.x - agent.x) ** 2 + (p.y - agent.y) ** 2))} steps away)`);
                const status = await stepToward(p, agent);
                console.log(`[EXECUTE] Move result: ${status} | now at (${Math.round(agent.x)},${Math.round(agent.y)})`);
                if (status === 'unreachable') {
                    // No path exists right now — mark immediately, penalty will decay over time
                    unreachableParcels.set(p.id, Date.now());
                    console.warn(`[STUCK] Parcel ${p.id} unreachable — penalizing, will retry as penalty decays`);
                    agent.intention = null;
                    agent.stuckCount = 0;
                } else if (status === 'stuck') {
                    agent.stuckCount++;
                    console.warn(`[STUCK] Count=${agent.stuckCount} trying to reach parcel ${p.id} at (${p.x},${p.y})`);
                    if (agent.stuckCount > 5) {
                        // Repeated move failures — also penalize
                        unreachableParcels.set(p.id, Date.now());
                        console.warn(`[STUCK] Parcel ${p.id} blocked after ${agent.stuckCount} failed moves — penalizing`);
                        agent.intention = null;
                        agent.stuckCount = 0;
                    }
                } else {
                    agent.stuckCount = 0;
                }
            }

            // Pickup if on the parcel — either already there at start, or just landed this step
            if (onParcel() && agent.intention?.type === 'PICKUP') {
                console.log(`[EXECUTE] PICKUP at (${p.x},${p.y})`);
                const pickedUp = await safeEmit(() => agent.socket.emitPickup(), 'PICKUP');
                if (pickedUp?.length > 0) {
                    const stackMax = agent.beliefs.missionConstraints?.stack?.max ?? null;
                    const newTotal = carriedCount + pickedUp.length;
                    if (stackMax !== null && newTotal > stackMax) {
                        // emitPickup grabbed more than stack.max allows — drop excess immediately
                        const excess = newTotal - stackMax;
                        const toDrop = pickedUp.slice(pickedUp.length - excess).map(q => q.id);
                        await safeEmit(() => agent.socket.emitPutdown(toDrop), 'PUTDOWN');
                        console.log(`[STACK] Picked up ${pickedUp.length}, dropped ${toDrop.length} excess to stay at max=${stackMax}`);
                    } else {
                        console.log(`[EXECUTE] ✓ Picked up ${pickedUp.length} parcel(s)`);
                    }
                    agent.intention = null;
                    agent.stuckCount = 0;
                } else {
                    // On the tile but nothing picked up: parcel is gone — penalize so we don't re-target the phantom
                    console.warn(`[EXECUTE] ✗ Pickup failed at (${p.x},${p.y}) - parcel gone, penalizing`);
                    unreachableParcels.set(p.id, Date.now());
                    agent.intention = null;
                }
            }

        } else if (agent.intention?.type === 'GOTO') {
            const gotoTile = agent.intention.tile;
            const gotoKey = `${gotoTile.x},${gotoTile.y}`;
            const isStable = Number.isInteger(agent.x) && Number.isInteger(agent.y);
            const onTile = isStable && agent.x === gotoTile.x && agent.y === gotoTile.y;

            console.log(`[EXECUTE] GOTO (${gotoTile.x},${gotoTile.y})`);
            if (onTile) {
                console.log(`[EXECUTE] ✓ Arrived at GOTO tile (${gotoTile.x},${gotoTile.y}), clearing`);
                agent.beliefs.tileUtilities.delete(gotoKey);
                agent.intention = null;
                agent.stuckCount = 0;
            } else {
                const status = await stepToward(gotoTile, agent);
                console.log(`[EXECUTE] Move result: ${status} | now at (${Math.round(agent.x)},${Math.round(agent.y)})`);
                if (status === 'unreachable') {
                    console.warn(`[UNREACHABLE] No path to GOTO tile (${gotoTile.x},${gotoTile.y}) - abandoning`);
                    agent.beliefs.tileUtilities.delete(gotoKey);
                    agent.intention = null;
                    agent.stuckCount = 0;
                } else if (status === 'stuck') {
                    agent.stuckCount++;
                    console.warn(`[STUCK] Count=${agent.stuckCount} trying to reach GOTO tile (${gotoTile.x},${gotoTile.y})`);
                    if (agent.stuckCount > 5) {
                        console.warn(`[STUCK] Abandoning GOTO tile (${gotoTile.x},${gotoTile.y}) as unreachable`);
                        agent.beliefs.tileUtilities.delete(gotoKey);
                        agent.intention = null;
                        agent.stuckCount = 0;
                    }
                } else {
                    agent.stuckCount = 0;
                }
            }

        } else {
            console.log(`[EXECUTE] EXPLORATION PHASE`);
            const target = computeBestSpawnTile(agent, visitedSpawns);
            if (target) {
                const dist = Math.round(Math.sqrt((target.x - agent.x) ** 2 + (target.y - agent.y) ** 2));
                console.log(`[EXECUTE] Moving to spawn at (${target.x},${target.y}) (${dist} steps away)`);
                const status = await stepToward(target, agent);
                console.log(`[EXECUTE] Move result: ${status} | now at (${Math.round(agent.x)},${Math.round(agent.y)})`);
                if (status === 'arrived') {
                    const now = Date.now();
                    visitedSpawns.set(`${target.x},${target.y}`, now);
                    for (const t of agent.beliefs.map.spawnTiles) {
                        if(Math.abs(t.x - target.x) + Math.abs(t.y - target.y) <= 2 ) {
                            visitedSpawns.set(`${t.x},${t.y}`, now);
                        }
                    }
                    console.log(`Explored spawn tile (${target.x},${target.y})`);
                }
                if (status === 'stuck') {
                    console.warn(`[STUCK] Cannot reach spawn at (${target.x},${target.y})`);
                    agent.stuckCount++;
                    if (agent.stuckCount > 5) {
                        console.warn(`[STUCK] stuckCount=${agent.stuckCount} > 5, marking spawn (${target.x},${target.y}) as visited`);
                        visitedSpawns.set(`${target.x},${target.y}`, Date.now());
                        agent.stuckCount = 0;
                    }
                }
            } else {
                console.warn('[EXECUTE] No spawn target found');
            }
        }

        // Small delay to prevent busy-waiting
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

agentLoop();

setInterval(() => {
    agent.beliefs.log();
    const c = agent.beliefs.missionConstraints;
    if (c.hasMission()) {
        log(`[MISSION_CONSTRAINTS] stack={min:${c.stack.min},max:${c.stack.max}} | preferredTiles=${c.preferred.tiles ? JSON.stringify(c.preferred.tiles) + `(x${c.preferred.multiplier})` : 'none'} | blacklist=[${[...c.blacklist.tiles].join(',')}] | rewardCap=${c.rewardCap.cap ?? 'none'} | forbidden=[${[...c.forbidden.tiles].join(',')}]`);
    } else {
        log('[MISSION_CONSTRAINTS] none active — standard play');
    }
}, 3000);
