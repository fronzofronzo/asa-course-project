import { Constraint } from './Constraint.js';

/**
 * Constraint: specific tiles must be avoided in BFS navigation.
 * Excluded from the walkable set during pathfinding.
 */
export class ForbiddenTileConstraint extends Constraint {
    constructor() {
        super();
        /** @type {Set<string>} Set of "x,y" keys excluded from navigation. */
        this.tiles = new Set();
    }

    /**
     * Mark tile at (x, y) as forbidden.
     * @param {number} x
     * @param {number} y
     */
    add(x, y) { this.tiles.add(`${Math.round(x)},${Math.round(y)}`); }

    /** @returns {boolean} */
    isActive() { return this.tiles.size > 0; }

    reset() { this.tiles.clear(); }

    /** @returns {{ forbiddenTiles: string[] }} */
    toJSON() { return { forbiddenTiles: [...this.tiles] }; }

    /**
     * @param {string} tileKey - "x,y" key to test.
     * @returns {boolean} true if this tile is forbidden for navigation.
     */
    isForbidden(tileKey) { return this.tiles.has(tileKey); }

    /**
     * EV = expected penalty avoided by routing around the tile − cost of detour steps.
     * @param {{ type:string, extra_steps?:number, penalty?:number, prob_enter?:number }} params
     * @param {{ avgReward:number, decay:number }} stats
     * @returns {{ ev:number, missionGain:number, standardGain:number }|null}
     */
    computeEV(params, stats) {
        if (params.type !== 'forbidden_tile') return null;
        const extraSteps = params.extra_steps ?? 3;
        const penaltyAvoided = params.penalty ?? 50;
        const probEnter = params.prob_enter ?? 0.2;
        const { avgReward, decay } = stats;
        const standardGain = decay * avgReward * extraSteps;
        const missionGain = penaltyAvoided * probEnter;
        return { ev: missionGain - standardGain, missionGain, standardGain };
    }
}
