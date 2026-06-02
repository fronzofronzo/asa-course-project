import { Constraint } from './Constraint.js';

/**
 * Constraint: freeze all agent movement until explicitly released.
 * Activated by "red light" commands; released by "green light" commands.
 * While frozen, move() and navigate_to() are blocked, and pick_up/put_down are refused.
 */
export class RedLightConstraint extends Constraint {
    constructor() {
        super();
        /** @type {boolean} */
        this.frozen = false;
    }

    /**
     * @param {boolean} frozen - true = red light (stop), false = green light (go)
     */
    set(frozen) { this.frozen = !!frozen; }

    /** @returns {boolean} */
    isActive() { return this.frozen; }

    reset() { this.frozen = false; }

    /** @returns {{ movementFrozen: boolean }} */
    toJSON() { return { movementFrozen: this.frozen }; }

    /**
     * @param {object[]} _carried
     * @param {object} _ctx
     * @returns {string|null}
     */
    checkPickup(_carried, _ctx) {
        return this.frozen ? 'Red light active: all movement and actions are frozen. Wait for green light.' : null;
    }

    /**
     * @param {string} _tileKey
     * @param {object[]} _carried
     * @param {object} _ctx
     * @returns {string|null}
     */
    checkPutdown(_tileKey, _carried, _ctx) {
        return this.frozen ? 'Red light active: all movement and actions are frozen. Wait for green light.' : null;
    }

    /**
     * EV = bonus awarded for complying with the red/green light game.
     * Always positive — the bonus outweighs any opportunity cost of pausing.
     * @param {{ type: string, bonus?: number }} params
     * @param {object} _stats
     * @returns {{ ev: number, guadagnoMissione: number, guadagnoStandard: number }|null}
     */
    computeEV(params, _stats) {
        if (params.type !== 'red_light') return null;
        const bonus = params.bonus ?? 10000;
        return { ev: bonus, guadagnoMissione: bonus, guadagnoStandard: 0 };
    }
}
