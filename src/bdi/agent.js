import 'dotenv/config'
import { BeliefSet } from './belief.js';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";


class Agent {
    constructor() {
        this.beliefs = new BeliefSet();
        this.id = null;
        this.name = null;
        this.score = 0;
        this.x = null;
        this.y = null;
        this.socket = new DjsConnect();
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
})

// main loop

setInterval(() => agent.beliefs.log(), 3000);