import { Constraint } from './Constraint.js';

/**
 * Constraint: manages state for L3 coordination missions (master-slave protocol).
 *
 * Three sub-states, all null/false when inactive:
 *   rendezvous  — meet_and_wait mission: navigate to (x,y) within maxDist, freeze, wait for peer
 *   handoff     — parcel_handoff mission: passer drops at tile, receiver picks up and delivers
 *   oddRowWait  — odd_row_wait mission: navigate to nearest odd-y tile, freeze until released
 */
export class CoordinationConstraint extends Constraint {
    constructor() {
        super();
        /** @type {{ x:number, y:number, maxDist:number, selfArrived:boolean, peerArrived:boolean }|null} */
        this.rendezvous = null;
        /** @type {{ role:'passer'|'receiver', tile:{x:number,y:number}, state:'pending'|'dropped' }|null} */
        this.handoff = null;
        /** @type {boolean} */
        this.oddRowWait = false;
        /** @type {boolean} */
        this.oddRowArrived = false;
    }

    /** @param {number} x @param {number} y @param {number} maxDist */
    setRendezvous(x, y, maxDist = 3) {
        this.rendezvous = { x, y, maxDist, selfArrived: false, peerArrived: false };
    }

    /**
     * @param {'passer'|'receiver'} role
     */
    setHandoff(role) {
        this.handoff = { role, state: 'pending', positionSent: false };
    }

    /** Clear the active handoff sub-state. */
    clearHandoff() { this.handoff = null; }

    /** Begin an odd-row-wait: freeze on the nearest odd-y tile until released. */
    setOddRowWait() { this.oddRowWait = true; this.oddRowArrived = false; }

    /** @returns {boolean} */
    isActive() { return !!(this.rendezvous || this.handoff || this.oddRowWait); }

    reset() {
        this.rendezvous = null;
        this.handoff    = null;
        this.oddRowWait = false;
        this.oddRowArrived = false;
    }

    /** @returns {object} */
    toJSON() {
        return {
            coordination: {
                rendezvous:    this.rendezvous,
                handoff:       this.handoff,
                oddRowWait:    this.oddRowWait,
                oddRowArrived: this.oddRowArrived,
            },
        };
    }

    /**
     * EV for coordination missions. Accounts for opportunity cost of stopping normal play.
     *
     * stats fields used (beyond the standard set):
     *   stats.pps           — points per second in standard play
     *   stats.movDurationSec — seconds per movement step
     *   stats.position      — {x, y} of the agent right now
     *
     * params fields per type:
     *   meet_and_wait:  bonus, x, y, wait_seconds (default 10)
     *   parcel_handoff: bonus, extra_steps (default 8)
     *   odd_row_wait:   bonus, steps_to_odd_row (default 3), wait_seconds (default 30)
     *
     * @param {{ type:string, [key:string]: any }} params
     * @param {{ pps:number, movDurationSec:number, position:{x:number,y:number} }} stats
     * @returns {{ ev:number, missionGain:number, standardGain:number }|null}
     */
    computeEV(params, stats) {
        const pps          = stats.pps          ?? 1;
        const movDurSec    = stats.movDurationSec ?? 0.5;
        const { x: mx = 0, y: my = 0 } = stats.position ?? {};

        if (params.type === 'meet_and_wait') {
            const bonus        = params.bonus ?? 500;
            const stepsToTarget = Math.abs(mx - (params.x ?? mx)) + Math.abs(my - (params.y ?? my));
            const waitSec      = params.wait_seconds ?? 10;
            const oppCost      = (stepsToTarget * movDurSec + waitSec) * pps;
            return { ev: bonus - oppCost, missionGain: bonus, standardGain: oppCost };
        }

        if (params.type === 'parcel_handoff') {
            const bonus    = params.bonus ?? 200;
            const extra    = params.extra_steps ?? 8;
            const oppCost  = extra * movDurSec * pps;
            return { ev: bonus - oppCost, missionGain: bonus, standardGain: oppCost };
        }

        if (params.type === 'odd_row_wait') {
            const bonus      = params.bonus ?? 700;
            const stepsOdd   = params.steps_to_odd_row ?? 3;
            const waitSec    = params.wait_seconds ?? 30;
            const oppCost    = (stepsOdd * movDurSec + waitSec) * pps;
            return { ev: bonus - oppCost, missionGain: bonus, standardGain: oppCost };
        }

        return null;
    }
}
