import { Constraint } from './Constraint.js';

/**
 * Constraint: enforce a minimum and/or maximum number of carried parcels.
 * - min: must carry at least N before delivering (stack missions)
 * - max: must not carry more than N (cap on pickup)
 * Both are independent and nullable.
 */
export class StackConstraint extends Constraint {
    constructor() {
        super();
        /** @type {number|null} Minimum parcels required before delivery. */
        this.min = null;
        /** @type {number|null} Maximum parcels allowed to carry at once. */
        this.max = null;
    }

    /**
     * Set a minimum-only stack requirement (used by llm_agent.js).
     * @param {number} n - minimum required stack size.
     */
    set(n) { this.min = n; this.max = null; }

    /**
     * Set min and/or max independently (used by mission_interpreter.js).
     * @param {number|null} min
     * @param {number|null} max
     */
    setMinMax(min, max) { this.min = min ?? null; this.max = max ?? null; }

    /** @returns {boolean} */
    isActive() { return this.min !== null || this.max !== null; }

    reset() { this.min = null; this.max = null; }

    /**
     * Exposes both `stack: {min, max}` (BDI schema) and `stackSize` (LLM schema) for compatibility.
     * @returns {{ stack: { min:number|null, max:number|null }, stackSize: number|null }}
     */
    toJSON() { return { stack: { min: this.min, max: this.max }, stackSize: this.min }; }

    /**
     * @param {object[]} carried - parcels currently carried.
     * @returns {boolean} true if min is satisfied (safe to deliver).
     */
    isReady(carried) {
        return this.min === null || carried.length >= this.min;
    }

    /**
     * Block pickup when the agent is already at the max stack limit.
     * @param {object[]} carried
     * @param {{ me: object, world: object }} ctx
     * @returns {string|null}
     */
    checkPickup(carried, ctx) {
        if (this.max !== null && carried.length >= this.max) {
            return `Mission constraint: already carrying ${carried.length}/${this.max} parcels (max). Deliver before picking up more.`;
        }
        return null;
    }

    /**
     * Block putdown when the agent has fewer parcels than the required minimum.
     * @param {string} tileKey
     * @param {object[]} carried
     * @param {{ me: object, world: object }} ctx
     * @returns {string|null}
     */
    checkPutdown(tileKey, carried, ctx) {
        if (this.min !== null && carried.length < this.min) {
            return `Mission constraint: carrying ${carried.length}/${this.min} required parcels. Collect ${this.min - carried.length} more before delivering.`;
        }
        return null;
    }

    /**
     * EV = (n parcels × reward × multiplier × decay factor) − (standard points earned in same time).
     * @param {{ type:string, n?:number, min?:number, multiplier?:number }} params
     * @param {{ avgReward:number, avgCollectTime:number, decay:number, pps:number }} stats
     * @returns {{ ev:number, guadagnoMissione:number, guadagnoStandard:number }|null}
     */
    computeEV(params, stats) {
        if (params.type !== 'stack') return null;
        const n = params.n ?? params.min ?? 3;
        const m = params.multiplier ?? 1;
        const { avgReward, avgCollectTime, decay, pps } = stats;
        const tempoTotale = n * avgCollectTime;
        const decayMedio = Math.min(0.99, decay * (n / 2) * avgCollectTime);
        const guadagnoMissione = n * avgReward * m * (1 - decayMedio);
        const guadagnoStandard = pps * tempoTotale;
        return { ev: guadagnoMissione - guadagnoStandard, guadagnoMissione, guadagnoStandard };
    }
}
