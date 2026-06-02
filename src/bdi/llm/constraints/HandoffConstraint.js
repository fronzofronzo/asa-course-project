import { Constraint } from './Constraint.js';

/**
 * Constraint: coordinate a parcel handoff between two agents.
 *
 * Role 'pickup':
 *   - Only pick up the target parcel (or nearest if parcelId=null).
 *   - After picking it up, navigate to handoffTile and put_down there (non-delivery drop).
 *   - put_down is only allowed at handoffTile.
 *
 * Role 'delivery':
 *   - Navigate to handoffTile, pick up the dropped parcel, deliver normally.
 *   - No parcel filter — picks up whatever is at the handoff point.
 */
export class HandoffConstraint extends Constraint {
    constructor() {
        super();
        /** @type {'pickup'|'delivery'|null} */
        this.role        = null;
        /** @type {string|null} Specific parcel ID to target (null = nearest) */
        this.parcelId    = null;
        /** @type {string|null} Partner agent's ID */
        this.partnerId   = null;
        /** @type {{ x:number, y:number }|null} Where to drop/pick up */
        this.handoffTile = null;
        /** @type {number} Bonus points for completing the handoff */
        this.bonus       = 200;
        /** @type {boolean} Pickup agent has dropped the parcel */
        this.dropped     = false;
    }

    /**
     * @param {'pickup'|'delivery'} role
     * @param {string|null} parcelId
     * @param {string|null} partnerId
     * @param {{ x:number, y:number }|null} handoffTile
     * @param {number} bonus
     */
    set(role, parcelId, partnerId, handoffTile, bonus) {
        this.role        = role;
        this.parcelId    = parcelId ?? null;
        this.partnerId   = partnerId ?? null;
        this.handoffTile = handoffTile
            ? { x: Math.round(handoffTile.x), y: Math.round(handoffTile.y) }
            : null;
        this.bonus       = bonus ?? 200;
        this.dropped     = false;
    }

    /** @returns {boolean} */
    isActive() { return this.role !== null; }

    reset() {
        this.role        = null;
        this.parcelId    = null;
        this.partnerId   = null;
        this.handoffTile = null;
        this.bonus       = 200;
        this.dropped     = false;
    }

    /** @returns {object} */
    toJSON() {
        return {
            handoff: this.role
                ? { role: this.role, parcelId: this.parcelId, partnerId: this.partnerId,
                    handoffTile: this.handoffTile, bonus: this.bonus, dropped: this.dropped }
                : null,
        };
    }

    /**
     * Pickup role: only allow the designated parcel (or all if parcelId is null).
     * Delivery role: no filter — picks up whatever is at handoff tile.
     * @param {{ id:string }} parcel
     * @returns {boolean}
     */
    allowParcel(parcel) {
        if (!this.isActive()) return true;
        if (this.role === 'pickup' && this.parcelId !== null) {
            return parcel.id === this.parcelId;
        }
        return true;
    }

    /**
     * Pickup role: only allow put_down at handoffTile (non-delivery drop to teammate).
     * Delivery role: no putdown restriction (delivers normally to any delivery tile).
     * @param {string} tileKey "x,y"
     * @param {object[]} _carried
     * @param {object} _ctx
     * @returns {string|null}
     */
    checkPutdown(tileKey, _carried, _ctx) {
        if (!this.isActive() || this.role !== 'pickup') return null;
        if (!this.handoffTile) return null;
        const expected = `${this.handoffTile.x},${this.handoffTile.y}`;
        if (tileKey !== expected) {
            return `Handoff active: must drop parcel at handoff tile (${expected}), not (${tileKey}).`;
        }
        return null;
    }

    /**
     * EV = bonus - cost of extra steps to handoff tile instead of nearest delivery.
     * @param {{ type:string, bonus?:number, extra_steps?:number }} params
     * @param {{ avgReward:number, decay:number }} stats
     * @returns {{ ev:number, guadagnoMissione:number, guadagnoStandard:number }|null}
     */
    computeEV(params, stats) {
        if (params.type !== 'handoff') return null;
        const bonus      = params.bonus       ?? 200;
        const extraSteps = params.extra_steps ?? 5;
        const guadagnoStandard = stats.decay * stats.avgReward * extraSteps;
        return { ev: bonus - guadagnoStandard, guadagnoMissione: bonus, guadagnoStandard };
    }
}
