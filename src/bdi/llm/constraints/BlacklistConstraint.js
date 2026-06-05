import { Constraint } from './Constraint.js';

/**
 * Constraint: specific delivery tiles are blacklisted and score 0 points.
 * Blocks putdown at those tiles and annotates them with `blacklisted: true`.
 */
export class BlacklistConstraint extends Constraint {
    constructor() {
        super();
        /** @type {Set<string>} Set of "x,y" keys that are forbidden for delivery. */
        this.tiles = new Set();
    }

    /**
     * Blacklist a tile at (x, y).
     * @param {number} x
     * @param {number} y
     */
    add(x, y) { this.tiles.add(`${Math.round(x)},${Math.round(y)}`); }

    /** @returns {boolean} */
    isActive() { return this.tiles.size > 0; }

    reset() { this.tiles.clear(); }

    /** @returns {{ blacklistedDeliveryTiles: string[] }} */
    toJSON() { return { blacklistedDeliveryTiles: [...this.tiles] }; }

    /**
     * Block putdown at any blacklisted tile.
     * @param {string} tileKey - "x,y" of the current tile.
     * @param {object[]} carried
     * @param {{ me: object, world: object }} ctx
     * @returns {string|null}
     */
    checkPutdown(tileKey, carried, ctx) {
        if (this.tiles.has(tileKey)) {
            const [cx, cy] = tileKey.split(',');
            return `Mission constraint: tile (${cx},${cy}) is blacklisted (0 pts). Navigate to a different delivery tile before putting down.`;
        }
        return null;
    }

    /**
     * Adds `blacklisted: boolean` to the tile object.
     * @param {{ x:number, y:number, distance:number }} tile
     * @returns {object}
     */
    decorateDeliveryTile(tile) {
        return { ...tile, blacklisted: this.tiles.has(`${tile.x},${tile.y}`) };
    }

    /**
     * EV is always positive: blacklisting avoids delivering at zero/penalty tiles.
     * @param {{ type:string }} params
     * @param {{ avgReward:number }} stats
     * @returns {{ ev:number, guadagnoMissione:number, guadagnoStandard:number }|null}
     */
    computeEV(params, stats) {
        if (params.type !== 'blacklist') return null;
        const ev = stats.avgReward ?? 10;
        return { ev, guadagnoMissione: ev, guadagnoStandard: 0 };
    }
}
