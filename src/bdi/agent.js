import 'dotenv/config'
import { BeliefSet } from './belief.js';
import { generateOptions, filterIntentions, go_to } from './deliberation.js';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";


const DECAY = parseFloat(process.env.DECAY_RATE) || 0.1;
const UTILITY_THRESHOLD = parseFloat(process.env.UTILITY_THRESHOLD) || 0;
const INTENTION_EPSILON = parseFloat(process.env.INTENTION_EPSILON) || 5;

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

async function agentLoop() {
    console.log('Agent loop started — waiting for first sensing...');

    while (true) {
        await agent.waitForBeliefChange();

        if (agent.x === null) continue; // position not yet known

        const agentPos = { x: agent.x, y: agent.y };
        const carriedCount = agent.carriedParcels.length;

        // D — desires
        const desires = generateOptions(
            agent.beliefs,
            agentPos,
            carriedCount,
            DECAY,
            UTILITY_THRESHOLD
        );

        // I — intention selection with hysteresis
        const newIntention = filterIntentions(desires, agent.intention, INTENTION_EPSILON);

        if (newIntention?.parcel.id !== agent.intention?.parcel.id) {
            agent.intention = newIntention;
            if (newIntention) {
                console.log(`New intention → parcel ${newIntention.parcel.id} at (${newIntention.parcel.x},${newIntention.parcel.y}) U=${newIntention.utility.toFixed(2)}`);
            } else {
                console.log('No viable intention — idle.');
            }
        }

        // TODO: execute(agent.intention) — plan + act (planner.js)
    }
}

agentLoop();

setInterval(() => agent.beliefs.log(), 3000);