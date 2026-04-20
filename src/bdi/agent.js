import 'dotenv/config'
import { BeliefSet } from './belief.js';
import { generateOptions, filterIntentions, stepToward } from './deliberation.js';
import { nearestDeliveryTile, nearestSpawnTile } from './planner.js';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";


const DECAY = parseFloat(process.env.DECAY_RATE) || 0.1;
const UTILITY_THRESHOLD = parseFloat(process.env.UTILITY_THRESHOLD) || 0;
const INTENTION_EPSILON = parseFloat(process.env.INTENTION_EPSILON) || 5;
const DELIVERY_URGENCY = parseFloat(process.env.DELIVERY_URGENCY) || 30;

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

        /** @type {(() => void) | null} resolves when next sensing arrives */
        this._beliefChangedResolve = null;
        this._beliefChanged = new Promise(res => { this._beliefChangedResolve = res; });
    }

    /** Call after every belief update to unblock the main loop. */
    _notifyBeliefChanged() {
        const res = this._beliefChangedResolve;
        this._beliefChanged = new Promise(r => { this._beliefChangedResolve = r; });
        res?.();
    }

    /** Suspend loop until next sensing event. */
    waitForBeliefChange() {
        return this._beliefChanged;
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
    agent.beliefs.updateAgents(agents);
    agent.beliefs.updateParcels(parcels);
    agent.carriedParcels = parcels.filter(p => p.carriedBy === agent.id);
    agent._notifyBeliefChanged();
})

const visitedSpawns = new Set();

async function agentLoop() {
    console.log('Agent loop started — waiting for first sensing...');

    while (true) {
        await agent.waitForBeliefChange();

        if (agent.x === null) continue;

        const agentPos = { x: agent.x, y: agent.y };
        const carriedCount = agent.carriedParcels.length;
        const carriedReward = agent.carriedParcels.reduce((sum, p) => sum + p.reward, 0);

        // --- deliberation ---

        const desires = generateOptions(agent.beliefs, agentPos, carriedCount, DECAY, UTILITY_THRESHOLD);
        const newIntention = filterIntentions(desires, agent.intention, INTENTION_EPSILON);

        if (newIntention?.parcel.id !== agent.intention?.parcel.id) {
            agent.intention = newIntention;
            if (newIntention) console.log(`New intention → parcel ${newIntention.parcel.id} at (${newIntention.parcel.x},${newIntention.parcel.y}) U=${newIntention.utility.toFixed(2)}`);
            else console.log('No viable intention.');
        }

        // --- execution (one step per tick — re-deliberates every sensing event) ---

        const shouldDeliver = carriedCount > 0 && (carriedReward >= DELIVERY_URGENCY || agent.intention === null);

        if (shouldDeliver) {
            const onDelivery = agent.beliefs.map.deliveryTiles
                .some(t => t.x === Math.round(agent.x) && t.y === Math.round(agent.y));

            if (onDelivery) {
                const dropped = await agent.socket.emitPutdown();
                console.log(`Delivered ${dropped.length} parcel(s)`);
            } else {
                const target = nearestDeliveryTile(agent);
                if (target) await stepToward(target, agent);
                else console.warn('No reachable delivery tile');
            }

        } else if (agent.intention !== null) {
            const p = agent.intention.parcel;
            const onParcel = Math.round(agent.x) === p.x && Math.round(agent.y) === p.y;

            if (onParcel) {
                const pickedUp = await agent.socket.emitPickup();
                if (pickedUp?.length > 0) console.log(`Picked up ${pickedUp.length} parcel(s)`);
                agent.intention = null;
            } else {
                const status = await stepToward({ x: p.x, y: p.y }, agent);
                if (status === 'stuck') {
                    console.warn(`Stuck going to parcel ${p.id}, dropping intention`);
                    agent.intention = null;
                }
            }

        } else {
            const target = nearestSpawnTile(agent, visitedSpawns);
            if (target) {
                const status = await stepToward(target, agent);
                if (status === 'arrived') visitedSpawns.add(`${target.x},${target.y}`);
            }
        }
    }
}

agentLoop();

setInterval(() => agent.beliefs.log(), 3000);