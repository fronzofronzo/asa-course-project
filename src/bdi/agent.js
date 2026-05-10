import 'dotenv/config'
import { BeliefSet } from './belief.js';
import { generateOptions, filterIntentions, stepToward } from './deliberation.js';
import { nearestDeliveryTile, bestSpawnTile } from './planner.js';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";


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
agent.socket.onYou(({id, name, x, y, score}) => {
    agent.updateInformation(id,name,x,y,score)
})
agent.socket.onSensing(({ agents, parcels }) => {                                                                                                                                                                     
    agent.beliefs.updateBeliefs({ agents, parcels });
    agent.carriedParcels = parcels.filter(p => p.carriedBy === agent.id);                                                                                                                                             
    agent._notifyBeliefChanged();                                        
}); 

const visitedSpawns = new Map(); // key → timestamp of last visit

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
        const desires = generateOptions(agent.beliefs, agentPos, carriedCount, DECAY, UTILITY_THRESHOLD);

        // --- deliberation (periodic, on belief change, or when intention just cleared) ---
        if (agent.shouldDeliberate() || agent.intention == null) {
            console.log(`\n[DELIBERATION] at (${Math.round(agent.x)},${Math.round(agent.y)}) | carried=${carriedCount} reward=${carriedReward.toFixed(1)}`);
            console.log(`[DELIBERATION] Found ${desires.length} viable parcel(s)`);
            if (desires.length > 0) {
                console.log(`[DELIBERATION] Top 3: ${desires.slice(0, 3).map(d => `(${d.parcel.id}@${d.parcel.x},${d.parcel.y} U=${d.utility.toFixed(1)})`).join(' | ')}`);
            }

            const newIntention = filterIntentions(desires, agent.intention, INTENTION_EPSILON);

            if (newIntention?.parcel.id !== agent.intention?.parcel.id) {
                agent.intention = newIntention;
                agent.stuckCount = 0;
                if (newIntention) {
                    console.log(`[INTENTION] NEW: parcel ${newIntention.parcel.id} at (${newIntention.parcel.x},${newIntention.parcel.y}) U=${newIntention.utility.toFixed(2)}`);
                } else {
                    console.log('[INTENTION] CLEARED: no viable parcel');
                }
            } else if (agent.intention) {
                console.log(`[INTENTION] HELD: parcel ${agent.intention.parcel.id} at (${agent.intention.parcel.x},${agent.intention.parcel.y}) U=${agent.intention.utility.toFixed(2)}`);
            }
            agent.recordDeliberation();
        }

        // --- execution (continuous, one step per iteration) ---
        // Deliver only when deliberation found no parcel worth pursuing.
        // DELIVERY_URGENCY applies inside utility: high carriedReward makes picking up detours less attractive.
        const shouldDeliver = carriedCount > 0 && agent.intention === null;

        if (shouldDeliver) {
            console.log(`[EXECUTE] DELIVERY PHASE (carried=${carriedCount}, reward=${carriedReward.toFixed(1)})`);
            const onDelivery = agent.beliefs.map.deliveryTiles
                .some(t => t.x === Math.round(agent.x) && t.y === Math.round(agent.y));

            if (onDelivery) {
                const dropped = await agent.socket.emitPutdown();
                console.log(`[EXECUTE] ✓ Delivered ${dropped.length} parcel(s) at (${Math.round(agent.x)},${Math.round(agent.y)})`);
            } else {
                const target = nearestDeliveryTile(agent);
                if (target) {
                    console.log(`[EXECUTE] Moving to delivery (${target.x},${target.y})`);
                    const status = await stepToward(target, agent);
                    console.log(`[EXECUTE] Move result: ${status} now at (${Math.round(agent.x)},${Math.round(agent.y)})`);
                    if (status === 'stuck') agent.stuckCount++;
                } else {
                    console.warn('[EXECUTE] ✗ No reachable delivery tile');
                }
            }

        } else if (agent.intention !== null) {
            const p = agent.intention.parcel;
            const onParcel = Math.round(agent.x) === p.x && Math.round(agent.y) === p.y;

            if (onParcel) {
                console.log(`[EXECUTE] PICKUP at (${p.x},${p.y})`);
                const pickedUp = await agent.socket.emitPickup();
                if (pickedUp?.length > 0) {
                    console.log(`[EXECUTE] ✓ Picked up ${pickedUp.length} parcel(s)`);
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
                if (status === 'stuck') {
                    agent.stuckCount++;
                    console.warn(`[STUCK] Count=${agent.stuckCount} trying to reach parcel ${p.id} at (${p.x},${p.y})`);
                    if (agent.stuckCount > 5) {
                        console.warn(`[STUCK] Clearing intention after ${agent.stuckCount} failed moves`);
                        agent.intention = null;
                        agent.stuckCount = 0;
                    }
                } else {
                    agent.stuckCount = 0;
                }
            }

        } else {
            console.log(`[EXECUTE] EXPLORATION PHASE`);
            const target = bestSpawnTile(agent, visitedSpawns);
            if (target) {
                const dist = Math.round(Math.sqrt((target.x - agent.x) ** 2 + (target.y - agent.y) ** 2));
                console.log(`[EXECUTE] Moving to spawn at (${target.x},${target.y}) (${dist} steps away)`);
                const status = await stepToward(target, agent);
                console.log(`[EXECUTE] Move result: ${status} | now at (${Math.round(agent.x)},${Math.round(agent.y)})`);
                if (status === 'arrived') visitedSpawns.set(`${target.x},${target.y}`, Date.now());
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

setInterval(() => agent.beliefs.log(), 3000);