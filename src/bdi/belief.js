import { bfsDist, computeSpawnHeat} from './utils.js';
import { MissionConstraints } from './llm/constraints/MissionConstraints.js';

const LAMBDA = 0.3;

class BeliefSet {
    constructor() {
        this.map = {
            width: null,
            height: null,
            tiles: new Map(),
            deliveryTiles: [],
            spawnTiles: [],
            walkable: new Set(),
            exitDirs: new Map(),
            spawnHeat: new Map(),
            pushTargets: new Set(),
        };
        this.parcels = new Map();
        this.agents  = new Map();
        this.crates  = new Map();
        this.tileUtilities = new Map();
        this.missionConstraints = new MissionConstraints();
    }

    /**
     * Update the belief set with the latest parcel information.
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
     * Update the belief set with the latest agent information.
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

    /**
     * Update the belief set with the latest crate information.
     * @param {import('@unitn-asa/deliveroo-js-sdk/src/types/IOCrate').IOCrate[]} crates
     */
    updateCrates(crates) {
        for (const c of crates) {
            this.crates.set(c.id, { id: c.id, x: Math.round(c.x), y: Math.round(c.y) });
        }
    }

    /** 
     * @returns {Set<string>} "x,y" keys currently occupied by a crate */
    crateCells() {
        const s = new Set();
        for (const c of this.crates.values()) s.add(`${c.x},${c.y}`);
        return s;
    }

    /**
     * Update beliefs with the latest sensing data.
     * @param {{ agents: object[], parcels: object[], crates?: object[] }} sensing
     * @returns {{ newParcels: object[], lostParcelIds: string[] }}
     */
    updateBeliefs({ agents, parcels, crates }) {
        const before = new Set(this.parcels.keys());
        this.updateAgents(agents);
        this.updateParcels(parcels);
        this.updateCrates(crates ?? []);
        const after = new Set(this.parcels.keys());
        const newParcels = [...after].filter(id => !before.has(id)).map(id => this.parcels.get(id));
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

    /**
     * Update the belief set with the latest map information.
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
        this.map.pushTargets.clear();
        this.crates.clear();

        const ARROW_DIR = { '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' };

        for (const tile of tiles) {
            const key = `${tile.x},${tile.y}`;
            this.map.tiles.set(key, tile);

            if (tile.type == 0) continue;

            this.map.walkable.add(key);
            // crate sliding tile / spawner: the only cells a crate may be pushed onto (yellow)
            if (tile.type === '5' || tile.type === '5!') this.map.pushTargets.add(key);
            if (tile.type == 2) this.map.deliveryTiles.push(tile);
            if (tile.type == 1) {
                this.map.spawnTiles.push(tile);
                this.map.spawnHeat.set(key, computeSpawnHeat(tile, tiles, 3));
            }

            const dir = ARROW_DIR[tile.type];
            if (dir) this.map.exitDirs.set(key, new Set([dir]));
        }
    }

}

BeliefSet.PARCEL_TTL_MS = 5000;
BeliefSet.AGENT_TTL_MS  = 3000;

export { BeliefSet };