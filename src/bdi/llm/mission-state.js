// Shared singleton — LLM writes here, BDI reads during deliberation and execution.
export const missionState = {
    stackSize: null,                      // deliver only when carrying >= N (or == N if stackExact)
    stackExact: false,                    // if true: deliver only when carrying === stackSize
    preferredDeliveryTiles: null,         // [{x, y}] — only deliver here when set
    preferredDeliveryMultiplier: 1,       // reward multiplier for preferred tiles
    blacklistedDeliveryTiles: new Set(),  // "x,y" keys — never deliver here
    rewardCap: null,                      // skip parcels with reward > cap
    forbiddenTiles: new Set(),            // "x,y" keys — avoid in navigation
    visitTargets: null,                   // [{x,y}] — one-time tile visit mission
    visitBonus: 0,                        // utility score injected for visit target tiles
    visitConsumed: false,                 // true once agent arrived at a visit target
};

export function hasMission() {
    return (
        missionState.stackSize !== null ||
        missionState.preferredDeliveryTiles !== null ||
        missionState.blacklistedDeliveryTiles.size > 0 ||
        missionState.rewardCap !== null ||
        missionState.forbiddenTiles.size > 0 ||
        (missionState.visitTargets !== null && !missionState.visitConsumed)
    );
}

export function getMissionSnapshot() {
    return {
        stackSize: missionState.stackSize,
        stackExact: missionState.stackExact,
        preferredDeliveryTiles: missionState.preferredDeliveryTiles,
        preferredDeliveryMultiplier: missionState.preferredDeliveryMultiplier,
        blacklistedDeliveryTiles: [...missionState.blacklistedDeliveryTiles],
        rewardCap: missionState.rewardCap,
        forbiddenTiles: [...missionState.forbiddenTiles],
        visitTargets: missionState.visitTargets,
        visitBonus: missionState.visitBonus,
        visitConsumed: missionState.visitConsumed,
        hasMission: hasMission(),
    };
}

export function resetMissionState() {
    missionState.stackSize = null;
    missionState.stackExact = false;
    missionState.preferredDeliveryTiles = null;
    missionState.preferredDeliveryMultiplier = 1;
    missionState.blacklistedDeliveryTiles.clear();
    missionState.rewardCap = null;
    missionState.forbiddenTiles.clear();
    missionState.visitTargets = null;
    missionState.visitBonus = 0;
    missionState.visitConsumed = false;
}
