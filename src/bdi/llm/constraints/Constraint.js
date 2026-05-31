/**
 * Base class for mission constraints. All methods are no-ops by default.
 * Subclasses override only the hooks they need.
 */
export class Constraint {
    /**
     * @returns {boolean} true if this constraint is currently active.
     */
    isActive() { return false; }

    /**
     * Clear all state, returning this constraint to its inactive default.
     */
    reset() {}

    /**
     * Serialize constraint state for getMissionState().
     * @returns {object}
     */
    toJSON() { return {}; }

    /**
     * Gate a pickup action.
     * @param {object[]} carried - parcels currently carried by the agent.
     * @param {{ me: object, world: object }} ctx - agent and world state.
     * @returns {string|null} rejection reason, or null if pickup is allowed.
     */
    checkPickup(carried, ctx) { return null; }

    /**
     * Gate a putdown action.
     * @param {string} tileKey - "x,y" key of the current tile.
     * @param {object[]} carried - parcels currently carried by the agent.
     * @param {{ me: object, world: object }} ctx - agent and world state.
     * @returns {string|null} rejection reason, or null if putdown is allowed.
     */
    checkPutdown(tileKey, carried, ctx) { return null; }

    /**
     * @param {string} tileKey - "x,y" key to test.
     * @returns {boolean} true if this tile must be excluded from BFS navigation.
     */
    isForbidden(tileKey) { return false; }

    /**
     * @param {object} parcel - parcel object with at least a `reward` field.
     * @returns {boolean} false if this parcel should be hidden from getParcels().
     */
    allowParcel(parcel) { return true; }

    /**
     * Annotate a delivery tile with constraint-specific fields (e.g. blacklisted, preferred).
     * @param {{ x:number, y:number, distance:number }} tile
     * @returns {object} tile with additional fields merged in.
     */
    decorateDeliveryTile(tile) { return tile; }

    /**
     * Compute expected value for a mission of the given type.
     * @param {{ type: string, [key: string]: any }} params - mission parameters.
     * @param {{ avgReward:number, avgCollectTime:number, decay:number, pps:number }} stats - rolling game stats.
     * @returns {{ ev:number, guadagnoMissione:number, guadagnoStandard:number }|null} null if type not handled.
     */
    computeEV(params, stats) { return null; }
}
