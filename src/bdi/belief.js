import { bfsDist } from './utils.js';

const LAMBDA = 0.3;

class BeliefSet {
    constructor() {
        this.map = {
            width: null,
            height: null,
            tiles: new Map(),      // key: `${x},${y}` → { x, y, type }
            deliveryTiles: [],     // IOTile[] where type === '2'
            spawnTiles: [],        // IOTile[] where type === '1'
            walkable: new Set(),   // Set of `${x},${y}` strings
            exitDirs: new Map(),   // key: `${x},${y}` → Set of allowed exit directions ('up'|'down'|'left'|'right'); absent = all directions allowed
        };
        this.parcels = new Map();  // id → { id, x, y, reward, carriedBy, lastSeen, beliefScore, inRange }
        this.agents  = new Map();  // id → { id, name, x, y, score, lastSeen }
    }

    /**
     * @param {import('@unitn-asa/deliveroo-js-sdk/src/types/IOParcel').IOParcel[]} parcels
     */
    updateParcels(parcels) {
        const now = Date.now();
        const seen = new Set();

        for (const p of parcels) {
            seen.add(p.id);
            this.parcels.set(p.id, {
                id: p.id,
                x: p.x,
                y: p.y,
                reward: p.reward,
                carriedBy: p.carriedBy ?? null,
                lastSeen: now,
                beliefScore: 1.0,
                inRange: true,
            });
        }

        // prune: reward exhausted OR unseen longer than TTL; mark survivors as out-of-range
        for (const [id, parcel] of this.parcels) {
            if (!seen.has(id)) {
                if (parcel.reward <= 0 || now - parcel.lastSeen > BeliefSet.PARCEL_TTL_MS) {
                    this.parcels.delete(id);
                } else {
                    parcel.inRange = false;
                }
            }
        }
    }

    /**
     * @param {import('@unitn-asa/deliveroo-js-sdk/src/types/IOAgent').IOAgent[]} agents
     */
    updateAgents(agents) {
        const now = Date.now();
        const seen = new Set();

        for (const a of agents) {
            seen.add(a.id);
            this.agents.set(a.id, {
                id: a.id,
                name: a.name,
                x: a.x,
                y: a.y,
                score: a.score,
                lastSeen: now,
            });
        }

        // keep recently-seen agents for opponent proximity calculation in uncertainty estimation
        for (const [id, ag] of this.agents) {
            if (!seen.has(id) && now - ag.lastSeen > BeliefSet.AGENT_TTL_MS) {
                this.agents.delete(id);
            }
        }
    }

     updateBeliefs({ agents, parcels }) {
      const before = new Set(this.parcels.keys());                                                                                                                                                                      
      this.updateAgents(agents);
      this.updateParcels(parcels);
      const after = new Set(this.parcels.keys());                                                                                                                                                                       
   
      const newParcels = [...after]                                                                                                                                                                                     
          .filter(id => !before.has(id))
          .map(id => this.parcels.get(id));
      const lostParcelIds = [...before].filter(id => !after.has(id));                                                                                                                                                   
      return { newParcels, lostParcelIds };
    }   

    /**
     * Recompute beliefScore for every out-of-range parcel.
     * Call once per BDI cycle, after updateBeliefs().
     * @param {{ x:number, y:number }} agentPos  own stable (integer) position
     */
    updateParcelUncertainty(agentPos) {
        const now = Date.now();
        for (const parcel of this.parcels.values()) {
            if (parcel.inRange) {
                parcel.beliefScore = 1.0;
                continue;
            }

            const distMe = bfsDist(
                { x: Math.round(agentPos.x), y: Math.round(agentPos.y) },
                { x: parcel.x, y: parcel.y },
                this.map.walkable
            );
            const deltaT = (now - parcel.lastSeen) / 1000;
            const D = distMe === Infinity ? 0 : Math.exp(-LAMBDA * distMe * deltaT);

            let minOppDist = Infinity;
            for (const ag of this.agents.values()) {
                const d = bfsDist(
                    { x: Math.round(ag.x), y: Math.round(ag.y) },
                    { x: parcel.x, y: parcel.y },
                    this.map.walkable
                );
                if (d < minOppDist) minOppDist = d;
            }
            const R = minOppDist === Infinity ? 0 : 1 - Math.exp(-LAMBDA * minOppDist);

            parcel.beliefScore = D * (1 - R);
        }
    }

    log() {
        console.log('--- BeliefSet ---');
        console.log(`Map: ${this.map.width}x${this.map.height} | walkable: ${this.map.walkable.size} | delivery: ${this.map.deliveryTiles.length} | spawn: ${this.map.spawnTiles.length}`);
        console.log(`Parcels (${this.parcels.size}):`);
        for (const p of this.parcels.values()) {
            const age = Math.round((Date.now() - p.lastSeen) / 1000);
            const bs  = p.beliefScore?.toFixed(3) ?? '1.000';
            console.log(`  [${p.id}] (${p.x},${p.y}) reward=${p.reward} carriedBy=${p.carriedBy ?? 'none'} age=${age}s belief=${bs} inRange=${p.inRange}`);
        }
        console.log(`Agents (${this.agents.size}):`);
        for (const a of this.agents.values()) {
            const age = Math.round((Date.now() - a.lastSeen) / 1000);
            console.log(`  [${a.id}] ${a.name} (${a.x},${a.y}) score=${a.score} age=${age}s`);
        }
        console.log('-----------------');
    }

    /**
 * @param {number} width
 * @param {number} height
 * @param {import('@unitn-asa/deliveroo-js-sdk/src/types/IOTile').IOTile[]} tiles
 */
updateMap(width, height, tiles) {
    this.map.width = width;
    this.map.height = height;
    this.map.tiles.clear();
    this.map.deliveryTiles = [];
    this.map.spawnTiles = [];
    this.map.walkable.clear();
    this.map.exitDirs.clear();

    const ARROW_DIR = { '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' };

    for (const tile of tiles) {
        const key = `${tile.x},${tile.y}`;
        this.map.tiles.set(key, tile);

        if (tile.type == 0) continue;

        this.map.walkable.add(key);
        console.log(tile.type)
        if (tile.type == 2) this.map.deliveryTiles.push(tile);
        if (tile.type == 1) {
            console.log("Questa è una spawining tile")
            this.map.spawnTiles.push(tile);
        }

        const dir = ARROW_DIR[tile.type];
        if (dir) this.map.exitDirs.set(key, new Set([dir]));
    }
    console.log("Queste sono le spawn tiles", this.map.spawnTiles)
}
}

BeliefSet.PARCEL_TTL_MS = 5000;
BeliefSet.AGENT_TTL_MS  = 2000;

export { BeliefSet };