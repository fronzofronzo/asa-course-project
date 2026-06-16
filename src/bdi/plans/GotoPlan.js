import { stepToward } from '../deliberation.js';

export const GotoPlan = {
    applicable: (intention) => intention?.type === 'GOTO',

    execute: async (agent, ctx) => {
        const gotoTile = agent.intention.tile;
        const gotoKey = `${gotoTile.x},${gotoTile.y}`;
        const isStable = Number.isInteger(agent.x) && Number.isInteger(agent.y);
        const onTile = isStable && agent.x === gotoTile.x && agent.y === gotoTile.y;

        if (onTile) {
            agent.beliefs.tileUtilities.delete(gotoKey);
            agent.intention = null;
            agent.stuckCount = 0;
        } else {
            const status = await stepToward(gotoTile, agent);
            if (status === 'unreachable') {
                agent.beliefs.tileUtilities.delete(gotoKey);
                agent.intention = null;
                agent.stuckCount = 0;
            } else if (status === 'stuck') {
                agent.stuckCount++;
                if (agent.stuckCount > 5) {
                    agent.beliefs.tileUtilities.delete(gotoKey);
                    agent.intention = null;
                    agent.stuckCount = 0;
                }
            } else {
                agent.stuckCount = 0;
            }
        }
    },
};
