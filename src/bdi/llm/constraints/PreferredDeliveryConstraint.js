import { Constraint } from './Constraint.js';

/**
 * Constraint: deliver only at specific tiles, which award a reward multiplier.
 * Annotates delivery tiles with a `preferred` boolean flag.
 */
export class PreferredDeliveryConstraint extends Constraint {
    constructor() {
        super();
        /** @type {{ x:number, y:number }[]|null} Allowed delivery positions, or null if inactive. */
        this.tiles = null;
        /** @type {number} Reward multiplier applied at preferred tiles. */
        this.multiplier = 1;
    }

    /**
     * @param {{ x:number, y:number }[]} tiles - preferred delivery positions.
     * @param {number} [multiplier=1] - reward multiplier at those tiles.
     */
    set(tiles, multiplier = 1) {
        this.tiles = tiles.map(t => ({ x: Math.round(t.x), y: Math.round(t.y) }));
        this.multiplier = multiplier;
    }

    /** @returns {boolean} */
    isActive() { return this.tiles !== null; }

    reset() { this.tiles = null; this.multiplier = 1; }

    /** @returns {{ preferredDeliveryTiles: { x:number, y:number }[]|null, preferredDeliveryMultiplier: number }} */
    toJSON() { return { preferredDeliveryTiles: this.tiles, preferredDeliveryMultiplier: this.multiplier }; }

    /**
     * Adds `preferred: boolean` to the tile object.
     * @param {{ x:number, y:number, distance:number }} tile
     * @returns {object}
     */
    decorateDeliveryTile(tile) {
        return {
            ...tile,
            preferred: this.tiles !== null && this.tiles.some(p => p.x === tile.x && p.y === tile.y),
        };
    }

    /**
     * EV = (reward × multiplier + flat bonus) − (standard reward + decay cost of extra steps to reach preferred tile).
     * `bonus` is a one-shot flat reward awarded for delivering at the tile (e.g. "deliver at (x,y) for +1000pts").
     * @param {{ type:string, multiplier?:number, bonus?:number, extra_steps?:number }} params
     * @param {{ avgReward:number, decay:number }} stats
     * @returns {{ ev:number, guadagnoMissione:number, guadagnoStandard:number }|null}
     */
    computeEV(params, stats) {
        if (params.type !== 'preferred_tile') return null;
        const m = params.multiplier ?? 1;
        const bonus = params.bonus ?? 0;
        const extraSteps = params.extra_steps ?? 5;
        const { avgReward, decay } = stats;
        const guadagnoMissione = avgReward * m + bonus;
        const guadagnoStandard = avgReward + decay * avgReward * extraSteps;
        return { ev: guadagnoMissione - guadagnoStandard, guadagnoMissione, guadagnoStandard };
    }
}
