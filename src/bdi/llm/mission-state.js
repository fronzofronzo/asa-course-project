// Shared singleton — LLM writes here, BDI reads during deliberation and execution.
export const missionState = {
    stackSize: null,                      // deliver only when carrying >= N parcels
    preferredDeliveryTiles: null,         // [{x, y}] — only deliver here when set
    preferredDeliveryMultiplier: 1,       // reward multiplier for preferred tiles
    blacklistedDeliveryTiles: new Set(),  // "x,y" keys — never deliver here
    rewardCap: null,                      // skip parcels with reward > cap
    forbiddenTiles: new Set(),            // "x,y" keys — avoid in navigation
};

export function hasMission() {
    return (
        missionState.stackSize !== null ||
        missionState.preferredDeliveryTiles !== null ||
        missionState.blacklistedDeliveryTiles.size > 0 ||
        missionState.rewardCap !== null ||
        missionState.forbiddenTiles.size > 0
    );
}

export function getMissionSnapshot() {
    return {
        stackSize: missionState.stackSize,
        preferredDeliveryTiles: missionState.preferredDeliveryTiles,
        preferredDeliveryMultiplier: missionState.preferredDeliveryMultiplier,
        blacklistedDeliveryTiles: [...missionState.blacklistedDeliveryTiles],
        rewardCap: missionState.rewardCap,
        forbiddenTiles: [...missionState.forbiddenTiles],
        hasMission: hasMission(),
    };
}

export function resetMissionState() {
    missionState.stackSize = null;
    missionState.preferredDeliveryTiles = null;
    missionState.preferredDeliveryMultiplier = 1;
    missionState.blacklistedDeliveryTiles.clear();
    missionState.rewardCap = null;
    missionState.forbiddenTiles.clear();
}
