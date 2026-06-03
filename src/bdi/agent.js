import 'dotenv/config'
import { BeliefSet } from './belief.js';
import { generateOptions, filterIntentions, stepToward, distToNearestDelivery } from './deliberation.js';
import { nearestDeliveryTile, nearestSpawnTile, hottestSpawnTile, computeBestSpawnTile } from './planner.js';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { interpretMission } from './llm/mission_interpreter.js';
import { log, setLoggerName } from './logger.js';


const DECAY = parseFloat(process.env.DECAY_RATE) || 0.1;
const UTILITY_THRESHOLD = parseFloat(process.env.UTILITY_THRESHOLD) || 0;
const INTENTION_EPSILON = parseFloat(process.env.INTENTION_EPSILON) || 5;
const DELIBERATION_INTERVAL = parseInt(process.env.DELIBERATION_INTERVAL) || 500; // ms between re-deliberation

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
agent.socket.onYou(({id, name, x, y, score, penalty}) => {
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

const visitedSpawns = new Map(); // key → timestamp of last visit
const unreachableDeliveryTiles = new Map(); // key of delivery tiles found to be unreachable
const unreachableParcels = new Map(); // parcelId → timestamp when marked unreachable (penalty decays over time)

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
                }
            );
        } finally {
            llmBusy = false;
        }
    }
}

agent.socket.onMsg(async (senderId, name, msg, ack) => {
    console.log(`\n[MISSION] Message from ${name}: ${msg}`);
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
        const desires = generateOptions(agent.beliefs, agentPos, carriedCount, carriedReward, DECAY, UTILITY_THRESHOLD, unreachableParcels);

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

        // --- execution (continuous, one step per iteration) ---
        if (agent.intention?.type === 'DELIVER') {
            console.log(`[EXECUTE] DELIVERY PHASE (carried=${carriedCount}, reward=${carriedReward.toFixed(1)})`);
            const onDelivery = agent.beliefs.map.deliveryTiles
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
                        const dropped = await agent.socket.emitPutdown();
                        console.log(`[STACK] Carrying ${carriedCount}/${stackMin} min — delivering anyway (no more parcels to collect)`);
                        agent.stuckCount = 0;
                        agent.intention = null;
                    }
                } else {
                    const dropped = await agent.socket.emitPutdown();
                    console.log(`[EXECUTE] ✓ Delivered ${dropped.length} parcel(s) at (${Math.round(agent.x)},${Math.round(agent.y)})`);
                    agent.stuckCount = 0;
                    agent.intention = null;
                }
            } else {
                const target = nearestDeliveryTile(agent, unreachableDeliveryTiles);
                if (target) {
                    console.log(`[EXECUTE] Moving to delivery (${target.x},${target.y})`);
                    const status = await stepToward(target, agent);
                    console.log(`[EXECUTE] Move result: ${status} now at (${Math.round(agent.x)},${Math.round(agent.y)})`);
                    if (status === 'stuck') agent.stuckCount++;
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
            const isStable = Number.isInteger(agent.x) && Number.isInteger(agent.y);
            const onParcel = isStable && agent.x === p.x && agent.y === p.y;

            if (onParcel) {
                console.log(`[EXECUTE] PICKUP at (${p.x},${p.y})`);
                const pickedUp = await agent.socket.emitPickup();
                if (pickedUp?.length > 0) {
                    const stackMax = agent.beliefs.missionConstraints?.stack?.max ?? null;
                    const newTotal = carriedCount + pickedUp.length;
                    if (stackMax !== null && newTotal > stackMax) {
                        // emitPickup grabbed more than stack.max allows — drop excess immediately
                        const excess = newTotal - stackMax;
                        const toDrop = pickedUp.slice(pickedUp.length - excess).map(q => q.id);
                        await agent.socket.emitPutdown(toDrop);
                        console.log(`[STACK] Picked up ${pickedUp.length}, dropped ${toDrop.length} excess to stay at max=${stackMax}`);
                    } else {
                        console.log(`[EXECUTE] ✓ Picked up ${pickedUp.length} parcel(s)`);
                    }
                    agent.intention = null;
                    agent.stuckCount = 0;
                } else {
                    console.warn(`[EXECUTE] ✗ Pickup failed at (${p.x},${p.y}) - parcel may be gone`);
                    agent.intention = null;
                }
            } else {
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
                if (status === 'stuck') {
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
