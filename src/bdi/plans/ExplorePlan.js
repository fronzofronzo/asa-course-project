import { stepToward } from '../deliberation.js';
import { computeBestSpawnTile } from '../planner.js';

export const ExplorePlan = {
    applicable: (intention) => !intention,

    execute: async (agent, ctx) => {
        const target = computeBestSpawnTile(agent, ctx.visitedSpawns);
        if (target) {
            const status = await stepToward(target, agent);
            if (status === 'arrived') {
                const now = Date.now();
                ctx.visitedSpawns.set(`${target.x},${target.y}`, now);
                for (const t of agent.beliefs.map.spawnTiles) {
                    if (Math.abs(t.x - target.x) + Math.abs(t.y - target.y) <= 2) {
                        ctx.visitedSpawns.set(`${t.x},${t.y}`, now);
                    }
                }
            }
            if (status === 'unreachable') {
                ctx.visitedSpawns.set(`${target.x},${target.y}`, Date.now());
                agent.stuckCount = 0;
            }
            if (status === 'stuck') {
                agent.stuckCount++;
                if (agent.stuckCount > 5) {
                    ctx.visitedSpawns.set(`${target.x},${target.y}`, Date.now());
                    agent.stuckCount = 0;
                }
            }
        }
    },
};
