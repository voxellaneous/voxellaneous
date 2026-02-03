export type ProfilerData = {
  fps: number;
  frameTime: number;
  pingMs: number;
  lastTimeStamp: number;
};

export function updateProfilerData(performance: ProfilerData, time: DOMHighResTimeStamp): void {
  if (performance.lastTimeStamp === 0) {
    performance.lastTimeStamp = time;
    return;
  }

  const elapsed = time - performance.lastTimeStamp;
  performance.lastTimeStamp = time;
  performance.frameTime = elapsed;
  performance.fps = 1000 / elapsed;
}
