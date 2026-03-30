import type { UserCmd } from '../../voxellaneous-common/src/netcode';

const PLAYER_SPEED = 60.0;

export class LocalPlayer {
    position: [number, number, number];

    constructor(spawnPosition: [number, number, number]) {
        this.position = [...spawnPosition];
    }

    setPosition(pos: [number, number, number]) {
        this.position[0] = pos[0];
        this.position[1] = pos[1];
        this.position[2] = pos[2];
    }

    applyUserCmd(cmd: UserCmd, dt: number) {
        let mx = 0;
        let my = 0;
        let mz = 0;

        const dirX = cmd.viewDir.x || 0;
        const dirZ = cmd.viewDir.z || 0;

        // Normalize right vector once (perpendicular to forward on XZ plane)
        const rightX = -dirZ;
        const rightZ = dirX;
        const rightLen = Math.sqrt(rightX * rightX + rightZ * rightZ);
        const nrX = rightLen > 0 ? rightX / rightLen : 0;
        const nrZ = rightLen > 0 ? rightZ / rightLen : 0;

        if (cmd.forward)  { mx += dirX; mz += dirZ; }
        if (cmd.backward) { mx -= dirX; mz -= dirZ; }
        if (cmd.right)    { mx += nrX;  mz += nrZ; }
        if (cmd.left)     { mx -= nrX;  mz -= nrZ; }
        if (cmd.jump)     { my += 1; }
        if (cmd.descend)  { my -= 1; }

        const mLen = Math.sqrt(mx * mx + my * my + mz * mz);
        if (mLen > 0) {
            const moveStep = PLAYER_SPEED * dt / mLen;
            this.position[0] += mx * moveStep;
            this.position[1] += my * moveStep;
            this.position[2] += mz * moveStep;
        }
    }
}
