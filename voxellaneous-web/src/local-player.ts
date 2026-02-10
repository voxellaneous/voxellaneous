import type { UserCmd } from '../../voxellaneous-common/src/netcode';

const PLAYER_SPEED = 60.0;

export class LocalPlayer {
    position: [number, number, number];
    private velocity: [number, number, number] = [0, 0, 0];

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
        const rightX = -dirZ;
        const rightZ = dirX;

        if (cmd.forward) {
            mx += dirX;
            mz += dirZ;
        }
        if (cmd.backward) {
            mx -= dirX;
            mz -= dirZ;
        }
        if (cmd.right) {
            const len = Math.sqrt(rightX * rightX + rightZ * rightZ);
            const nrX = len > 0 ? rightX / len : 0;
            const nrZ = len > 0 ? rightZ / len : 0;
            mx += nrX;
            mz += nrZ;
        }
        if (cmd.left) {
            const len = Math.sqrt(rightX * rightX + rightZ * rightZ);
            const nrX = len > 0 ? rightX / len : 0;
            const nrZ = len > 0 ? rightZ / len : 0;
            mx -= nrX;
            mz -= nrZ;
        }
        if (cmd.jump) {
            my += 1;
        }
        if (cmd.descend) {
            my -= 1;
        }

        const mLen = Math.sqrt(mx * mx + my * my + mz * mz);
        if (mLen > 0) {
            mx /= mLen;
            my /= mLen;
            mz /= mLen;
            const moveStep = PLAYER_SPEED * dt;
            this.position[0] += mx * moveStep;
            this.position[1] += my * moveStep;
            this.position[2] += mz * moveStep;
            this.velocity = [mx * PLAYER_SPEED, my * PLAYER_SPEED, mz * PLAYER_SPEED];
        } else {
            this.velocity = [0, 0, 0];
        }
    }
}
