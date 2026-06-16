import { stepToward } from '../deliberation.js';
import { nearestDeliveryTile } from '../planner.js';
import { getEffectiveDeliveryTiles } from '../utils.js';

export const DeliverPlan = {
    applicable: (intention) => intention?.type === 'DELIVER',

    execute: async (agent, ctx) => {
        const effectiveDelivery = getEffectiveDeliveryTiles(agent.beliefs.map.deliveryTiles, agent.beliefs.missionConstraints ?? null);
        const onDelivery = effectiveDelivery
            .some(t => t.x === Math.round(agent.x) && t.y === Math.round(agent.y));

        if (onDelivery) {
            const rewardCap = agent.beliefs.missionConstraints?.rewardCap;
            const stackMin = agent.beliefs.missionConstraints?.stack?.min ?? null;
            const carriedCount = agent.carriedParcels.length;

            if (rewardCap?.mustHold?.(agent.carriedParcels)) {
                agent.stuckCount = 0;
            } else if (stackMin !== null && carriedCount < stackMin) {
                agent.intention = null;
            } else {
                await ctx.safeEmit(() => agent.socket.emitPutdown(), 'PUTDOWN');
                agent.stuckCount = 0;
                agent.intention = null;
            }
        } else {
            const target = nearestDeliveryTile(agent, ctx.unreachableDeliveryTiles);
            if (target) {
                const status = await stepToward(target, agent);
                if (status === 'unreachable') {
                    ctx.unreachableDeliveryTiles.set(`${target.x},${target.y}`, Date.now());
                    agent.stuckCount = 0;
                    agent.needsDeliberation = true;
                } else if (status === 'stuck') {
                    agent.stuckCount++;
                }
                if (agent.stuckCount > 5) {
                    ctx.unreachableDeliveryTiles.set(`${target.x},${target.y}`, Date.now());
                    agent.stuckCount = 0;
                }
            }
        }
    },
};
