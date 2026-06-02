import { Constraint } from './Constraint.js';

/**
 * Constraint: navigate both agents to the neighborhood of a target tile,
 * wait for each other, then release.
 *
 * State machine:
 *   inactive → navigating → myArrived (frozen, waiting) → fulfilled (both arrived, freeze released)
 */
export class RendezvousConstraint extends Constraint {
    constructor() {
        super();
        /** @type {{ x: number, y: number }|null} */
        this.center = null;
        /** @type {number} Manhattan radius — default 3 */
        this.radius = 3;
        /** @type {number} Bonus promised for compliance */
        this.bonus = 500;
        /** @type {string|null} Partner agent ID (used to send ARRIVED signal) */
        this.partnerId = null;
        /** @type {boolean} */
        this.myArrived = false;
        /** @type {boolean} */
        this.teammateArrived = false;
    }

    /**
     * Activate the rendezvous constraint.
     * @param {{ x:number, y:number }} center
     * @param {number} radius
     * @param {number} bonus
     * @param {string|null} partnerId
     */
    set(center, radius, bonus, partnerId) {
        this.center         = { x: Math.round(center.x), y: Math.round(center.y) };
        this.radius         = radius ?? 3;
        this.bonus          = bonus  ?? 500;
        this.partnerId      = partnerId ?? null;
        this.myArrived      = false;
        this.teammateArrived = false;
    }

    /** @returns {boolean} */
    isActive() { return this.center !== null; }

    /** @returns {boolean} Both agents are within radius of center. */
    isFulfilled() { return this.myArrived && this.teammateArrived; }

    /**
     * Check whether a given position is within the rendezvous radius.
     * @param {{ x:number, y:number }} pos
     * @returns {boolean}
     */
    checkInRange(pos) {
        if (!this.center) return false;
        return Math.abs(Math.round(pos.x) - this.center.x) +
               Math.abs(Math.round(pos.y) - this.center.y) <= this.radius;
    }

    /**
     * Mark own agent as arrived. Returns true if this is a new arrival.
     * @returns {boolean}
     */
    markMyArrival() {
        if (this.myArrived) return false;
        this.myArrived = true;
        return true;
    }

    /**
     * Mark teammate as arrived. Returns true if this is a new arrival.
     * @returns {boolean}
     */
    markTeammateArrival() {
        if (this.teammateArrived) return false;
        this.teammateArrived = true;
        return true;
    }

    reset() {
        this.center          = null;
        this.radius          = 3;
        this.bonus           = 500;
        this.partnerId       = null;
        this.myArrived       = false;
        this.teammateArrived = false;
    }

    /** @returns {object} */
    toJSON() {
        return {
            rendezvous: this.center
                ? { center: this.center, radius: this.radius, bonus: this.bonus,
                    myArrived: this.myArrived, teammateArrived: this.teammateArrived }
                : null,
        };
    }

    /**
     * While waiting for teammate (myArrived but not fulfilled), block pickup
     * so the agent stays put and does not run off to collect parcels.
     * @param {object[]} _carried
     * @param {object} _ctx
     * @returns {string|null}
     */
    checkPickup(_carried, _ctx) {
        if (this.isActive() && this.myArrived && !this.isFulfilled()) {
            return 'Rendezvous active: waiting for teammate to arrive — no pickup until both present.';
        }
        return null;
    }

    /**
     * EV = bonus - cost of detour steps.
     * @param {{ type:string, bonus?:number, estimated_steps?:number }} params
     * @param {{ avgReward:number, decay:number }} stats
     * @returns {{ ev:number, guadagnoMissione:number, guadagnoStandard:number }|null}
     */
    computeEV(params, stats) {
        if (params.type !== 'rendezvous') return null;
        const bonus         = params.bonus           ?? 500;
        const stepsToTarget = params.estimated_steps ?? 10;
        // Cost: losing parcel opportunities while navigating there and back
        const guadagnoStandard = stats.decay * stats.avgReward * stepsToTarget * 2;
        return { ev: bonus - guadagnoStandard, guadagnoMissione: bonus, guadagnoStandard };
    }
}
