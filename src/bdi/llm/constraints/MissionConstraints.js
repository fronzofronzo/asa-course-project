import { StackConstraint }             from './StackConstraint.js';
import { PreferredDeliveryConstraint } from './PreferredDeliveryConstraint.js';
import { BlacklistConstraint }          from './BlacklistConstraint.js';
import { RewardCapConstraint }          from './RewardCapConstraint.js';
import { ForbiddenTileConstraint }      from './ForbiddenTileConstraint.js';
import { RedLightConstraint }           from './RedLightConstraint.js';

/**
 * Registry and orchestrator for all active mission constraints.
 * Delegates every operation to the registered Constraint instances.
 * Adding a new constraint: create a subclass of Constraint, instantiate it here,
 * and push it to this._all. No other file needs to change.
 */
export class MissionConstraints {
    constructor() {
        this.stack     = new StackConstraint();
        this.preferred = new PreferredDeliveryConstraint();
        this.blacklist = new BlacklistConstraint();
        this.rewardCap = new RewardCapConstraint();
        this.forbidden = new ForbiddenTileConstraint();
        this.redLight  = new RedLightConstraint();
        /** @type {import('./Constraint.js').Constraint[]} */
        this._all = [this.stack, this.preferred, this.blacklist, this.rewardCap, this.forbidden, this.redLight];
    }

    /**
     * @returns {boolean} true if movement is currently frozen by a red light constraint.
     */
    isMovementFrozen() { return this.redLight.frozen; }

    /**
     * @returns {boolean} true if at least one constraint is active.
     */
    hasMission() { return this._all.some(c => c.isActive()); }

    /**
     * Reset all constraints to their inactive defaults.
     */
    reset() { this._all.forEach(c => c.reset()); }

    /**
     * Merge serialized state from all constraints into one flat object.
     * @returns {object}
     */
    toJSON() { return Object.assign({}, ...this._all.map(c => c.toJSON())); }

    /**
     * Gate a pickup action against all constraints. First rejection wins.
     * @param {object[]} carried - parcels currently carried by the agent.
     * @param {{ me: object, world: object }} ctx
     * @returns {string|null} rejection reason, or null if pickup is allowed.
     */
    checkPickup(carried, ctx) {
        for (const c of this._all) {
            const err = c.checkPickup(carried, ctx);
            if (err) return err;
        }
        return null;
    }

    /**
     * Gate a putdown action against all constraints. First rejection wins.
     * @param {string} tileKey - "x,y" of the current tile.
     * @param {object[]} carried - parcels currently carried by the agent.
     * @param {{ me: object, world: object }} ctx
     * @returns {string|null} rejection reason, or null if putdown is allowed.
     */
    checkPutdown(tileKey, carried, ctx) {
        for (const c of this._all) {
            const err = c.checkPutdown(tileKey, carried, ctx);
            if (err) return err;
        }
        return null;
    }

    /**
     * @param {string} tileKey - "x,y" key to test.
     * @returns {boolean} true if any constraint forbids this tile for navigation.
     */
    isForbidden(tileKey) { return this._all.some(c => c.isForbidden(tileKey)); }

    /**
     * Filter a parcel list through all constraints.
     * @param {object[]} parcels
     * @returns {object[]} parcels allowed by every active constraint.
     */
    filterParcels(parcels) { return parcels.filter(p => this._all.every(c => c.allowParcel(p))); }

    /**
     * Annotate a delivery tile with fields from all constraints (e.g. blacklisted, preferred).
     * @param {{ x:number, y:number, distance:number }} tile
     * @returns {object}
     */
    decorateDeliveryTile(tile) {
        return this._all.reduce((t, c) => c.decorateDeliveryTile(t), tile);
    }

    /**
     * Compute expected value for a mission. Dispatches to the first constraint that handles the type.
     * @param {{ type:string, [key:string]: any }} params
     * @param {{ avgReward:number, avgCollectTime:number, decay:number, pps:number }} stats
     * @returns {{ ev:number, guadagnoMissione:number, guadagnoStandard:number }|null} null if type unknown.
     */
    computeEV(params, stats) {
        for (const c of this._all) {
            const result = c.computeEV(params, stats);
            if (result !== null) return result;
        }
        return null;
    }
}
