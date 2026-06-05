import { Constraint } from './Constraint.js';

/**
 * Constraint: skip parcels whose reward exceeds a cap.
 * Filters parcels from getParcels() and blocks pickup at tiles with over-cap parcels.
 */
export class RewardCapConstraint extends Constraint {
    constructor() {
        super();
        /** @type {number|null} Maximum allowed parcel reward, or null if inactive. */
        this.cap = null;
    }

    /**
     * @param {number} cap - maximum reward value to collect.
     */
    set(cap) { this.cap = cap; }

    /** @returns {boolean} */
    isActive() { return this.cap !== null; }

    reset() { this.cap = null; }

    /** @returns {{ rewardCap: number|null }} */
    toJSON() { return { rewardCap: this.cap }; }

    /**
     * Block pickup when there are over-cap parcels on the current tile.
     * @param {object[]} carried
     * @param {{ me: object, world: object }} ctx
     * @returns {string|null}
     */
    checkPickup(carried, ctx) {
        if (this.cap === null) return null;
        const { me, world } = ctx;
        const overCap = world.parcels.filter(p =>
            !p.carriedBy &&
            Math.round(p.x) === Math.round(me.x) &&
            Math.round(p.y) === Math.round(me.y) &&
            p.reward > this.cap
        );
        if (overCap.length > 0) {
            return `Mission constraint: parcel reward (${overCap[0].reward.toFixed(1)}) exceeds cap (${this.cap}). Skipping pickup.`;
        }
        return null;
    }

    /**
     * @param {{ reward:number }} parcel
     * @returns {boolean} false if the parcel's reward exceeds the cap.
     */
    allowParcel(parcel) {
        return this.cap === null || parcel.reward <= this.cap;
    }

    /**
     * Imposed-penalty mission: over-cap deliveries score 0 whether or not we adapt.
     * ACCEPT = stop collecting over-cap parcels (every trip productive).
     * REJECT = keep collecting them, but a `fracAboveCap` share of effort yields 0 → wasted.
     * So EV = adaptive gain − (adaptive gain discounted by that wasted fraction) ≥ 0.
     * @param {{ type:string, cap?:number }} params
     * @param {{ avgReward:number }} stats
     * @returns {{ ev:number, guadagnoMissione:number, guadagnoStandard:number }|null}
     */
    computeEV(params, stats) {
        if (params.type !== 'reward_cap') return null;
        const cap = params.cap ?? 10;
        const { avgReward } = stats;
        const fracAboveCap = Math.max(0, 1 - cap / (avgReward * 2));
        const guadagnoMissione = avgReward * (1 - fracAboveCap);
        // Ignoring the rule wastes the over-cap fraction of effort (those deliveries pay 0).
        const guadagnoStandard = guadagnoMissione * (1 - fracAboveCap);
        return { ev: guadagnoMissione - guadagnoStandard, guadagnoMissione, guadagnoStandard };
    }
}
