import { stepToward } from '../deliberation.js';

export const PickupPlan = {
    applicable: (intention) => intention?.type === 'PICKUP',

    execute: async (agent, ctx) => {
        const p = agent.intention.parcel;
        const carriedCount = agent.carriedParcels.length;
        const onParcel = () => Number.isInteger(agent.x) && Number.isInteger(agent.y)
            && agent.x === p.x && agent.y === p.y;

        if (!onParcel()) {
            const status = await stepToward(p, agent);
            if (status === 'unreachable') {
                ctx.unreachableParcels.set(p.id, Date.now());
                agent.intention = null;
                agent.stuckCount = 0;
            } else if (status === 'stuck') {
                agent.stuckCount++;
                if (agent.stuckCount > 5) {
                    ctx.unreachableParcels.set(p.id, Date.now());
                    agent.intention = null;
                    agent.stuckCount = 0;
                }
            } else {
                agent.stuckCount = 0;
            }
        }

        if (onParcel() && agent.intention?.type === 'PICKUP') {
            const pickedUp = await ctx.safeEmit(() => agent.socket.emitPickup(), 'PICKUP');
            if (pickedUp?.length > 0) {
                const stackMax = agent.beliefs.missionConstraints?.stack?.max ?? null;
                const newTotal = carriedCount + pickedUp.length;
                if (stackMax !== null && newTotal > stackMax) {
                    const excess = newTotal - stackMax;
                    const toDrop = pickedUp.slice(pickedUp.length - excess).map(q => q.id);
                    await ctx.safeEmit(() => agent.socket.emitPutdown(toDrop), 'PUTDOWN');
                }
                agent.intention = null;
                agent.stuckCount = 0;
            } else {
                ctx.unreachableParcels.set(p.id, Date.now());
                agent.intention = null;
            }
        }
    },
};
