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
        this.parcels = new Map();  // id → { id, x, y, reward, carriedBy, lastSeen }
        this.agents = new Map();   // id → { id, name, x, y, score, lastSeen }
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
            });
        }

        // prune: reward exhausted OR unseen longer than TTL
        for (const [id, parcel] of this.parcels) {
            if (!seen.has(id) && (parcel.reward <= 0 || now - parcel.lastSeen > BeliefSet.PARCEL_TTL_MS)) {
                this.parcels.delete(id);
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

        // remove agents no longer in sensing range (mark uncertain via lastSeen age)
        for (const [id] of this.agents) {
            if (!seen.has(id)) {
                this.agents.delete(id);
            }
        }
    }

    updateBeliefs({ agents, parcels }) {
        const before = new Set(this.parcels.keys());
        this.updateAgents(agents);
        this.updateParcels(parcels);
        this.updateSpawnAgentCounts();
        const after = new Set(this.parcels.keys());

        const newParcels = [...after]
            .filter(id => !before.has(id))
            .map(id => this.parcels.get(id));
        const lostParcelIds = [...before].filter(id => !after.has(id));
        return { newParcels, lostParcelIds };
    }

    updateSpawnAgentCounts() {
        const agents = [...this.agents.values()];
        for (const tile of this.map.spawnTiles) {
            tile.nearbyAgentCount = agents.filter(a =>
                Math.abs(a.x - tile.x) + Math.abs(a.y - tile.y) <= BeliefSet.SPAWN_AGENT_RADIUS
            ).length;
        }
    }

    log() {
        console.log('--- BeliefSet ---');
        console.log(`Map: ${this.map.width}x${this.map.height} | walkable: ${this.map.walkable.size} | delivery: ${this.map.deliveryTiles.length} | spawn: ${this.map.spawnTiles.length}`);
        console.log(`Parcels (${this.parcels.size}):`);
        for (const p of this.parcels.values()) {
            const age = Math.round((Date.now() - p.lastSeen) / 1000);
            console.log(`  [${p.id}] (${p.x},${p.y}) reward=${p.reward} carriedBy=${p.carriedBy ?? 'none'} age=${age}s`);
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

BeliefSet.PARCEL_TTL_MS = 5000; // keep unseen parcel in beliefs for 5s
BeliefSet.SPAWN_AGENT_RADIUS = 3; // Manhattan radius to count nearby agents per spawn tile

export { BeliefSet };