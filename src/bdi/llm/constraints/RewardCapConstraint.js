import { Constraint } from './Constraint.js';

/**
 * Constraint: deliver only when the carried load qualifies under the cap.
 * Parcels are picked up freely (incl. over-cap ones); rewards decay continuously while carried,
 * so the agent holds, parks at a delivery tile, and delivers once it qualifies.
 * Gate ('sum' default, or 'each' via CAP_GATE_MODE): qualify when the carried TOTAL <= cap,
 * or when EACH carried parcel <= cap (deliver as soon as every parcel is individually under).
 */
export class RewardCapConstraint extends Constraint {
    constructor() {
        super();
        /** @type {number|null} Maximum allowed parcel reward, or null if inactive. */
        this.cap = null;
        /** @type {'single'|'stack'} How many parcels to carry per qualifying delivery. */
        this.mode = process.env.CAP_STACK_MODE === 'stack' ? 'stack' : 'single';
        /** @type {'sum'|'each'} Delivery qualifies when the carried TOTAL <= cap ('sum'), or when EACH carried parcel <= cap ('each'). */
        this.gate = process.env.CAP_GATE_MODE === 'each' ? 'each' : 'sum';
    }

    /**
     * @param {number} cap - maximum reward value to collect.
     * @param {'single'|'stack'|null} [mode] - override carry mode (kept if omitted/invalid).
     * @param {'sum'|'each'|null} [gate] - override delivery gate (kept if omitted/invalid).
     */
    set(cap, mode = null, gate = null) {
        this.cap = cap;
        if (mode === 'single' || mode === 'stack') this.mode = mode;
        if (gate === 'sum' || gate === 'each') this.gate = gate;
    }

    /** @returns {boolean} */
    isActive() { return this.cap !== null; }

    reset() {
        this.cap = null;
        this.mode = process.env.CAP_STACK_MODE === 'stack' ? 'stack' : 'single';
        this.gate = process.env.CAP_GATE_MODE === 'each' ? 'each' : 'sum';
    }

    /** @returns {{ rewardCap: number|null }} */
    toJSON() { return { rewardCap: this.cap }; }

    /**
     * Pickup is unrestricted — over-cap parcels are collected and held until they decay.
     * @returns {string|null}
     */
    checkPickup(carried, ctx) {
        return null;
    }

    /**
     * Pickup filter is disabled: every parcel is allowed; the cap is enforced at delivery instead.
     * @returns {boolean}
     */
    allowParcel(parcel) {
        return true;
    }

    /**
     * Whether the agent must keep holding (delivery not yet qualifying).
     * - gate 'sum':  the carried total exceeds the cap.
     * - gate 'each': any single carried parcel exceeds the cap.
     * @param {object[]} carried - parcels currently carried (live decayed `reward`).
     * @returns {boolean}
     */
    mustHold(carried) {
        if (this.cap === null) return false;
        if (this.gate === 'each') return carried.some(p => (p.reward ?? 0) > this.cap);
        return carried.reduce((sum, p) => sum + (p.reward ?? 0), 0) > this.cap;
    }

    /**
     * Decide whether to pick up one more parcel given the current carried load and mode.
     * - single: one parcel per trip (max number of qualifying deliveries).
     * - stack ('sum'):  keep adding parcels while the live total stays within the cap.
     * - stack ('each'): keep adding any parcel that is itself within the cap.
     * The first parcel is always allowed (incl. an expensive one — the hybrid fallback that is then held).
     * @param {number} carriedReward - summed live (decayed) reward currently carried.
     * @param {number} carriedCount - number of parcels currently carried.
     * @param {number} parcelReward - candidate parcel's live (decayed) reward.
     * @returns {boolean}
     */
    allowsAdditionalPickup(carriedReward, carriedCount, parcelReward) {
        if (this.cap === null) return true;
        if (carriedCount === 0) return true;
        if (this.mode === 'single') return false;
        if (this.gate === 'each') return parcelReward <= this.cap;
        return carriedReward + parcelReward <= this.cap;
    }

    /**
     * Block delivery until it qualifies: total <= cap ('sum') or every parcel <= cap ('each').
     * @param {string} tileKey
     * @param {object[]} carried
     * @param {{ me: object, world: object }} ctx
     * @returns {string|null}
     */
    checkPutdown(tileKey, carried, ctx) {
        if (this.cap === null) return null;
        if (this.gate === 'each') {
            const over = carried.filter(p => (p.reward ?? 0) > this.cap);
            if (over.length > 0) {
                return `Mission constraint: ${over.length} carried parcel(s) exceed cap (${this.cap}). Holding for decay.`;
            }
            return null;
        }
        const total = carried.reduce((sum, p) => sum + (p.reward ?? 0), 0);
        if (total > this.cap) {
            return `Mission constraint: carried total (${total.toFixed(1)}) exceeds cap (${this.cap}). Holding for decay.`;
        }
        return null;
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
