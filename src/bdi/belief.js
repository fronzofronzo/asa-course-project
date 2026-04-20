class BeliefSet {
    constructor() {
        this.map = {
            width: null,
            height: null,
            tiles: new Map(),      // key: `${x},${y}` → { x, y, type }
            deliveryTiles: [],     // IOTile[] where type === '2'
            spawnTiles: [],        // IOTile[] where type === '1'
            walkable: new Set(),   // Set of `${x},${y}` strings
        };
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

        for (const tile of tiles) {
            const key = `${tile.x},${tile.y}`;
            this.map.tiles.set(key, tile);

            if (tile.type !== '0') this.map.walkable.add(key);
            if (tile.type === '2') this.map.deliveryTiles.push(tile);
            if (tile.type === '1') this.map.spawnTiles.push(tile);
        }
    }
}

export { BeliefSet };