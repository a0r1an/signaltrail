import { readFile } from 'node:fs/promises';

const paths = {
  cgroupCpuStat: '/sys/fs/cgroup/cpu.stat',
  cgroupCpuMax: '/sys/fs/cgroup/cpu.max',
  cgroupCpuPressure: '/sys/fs/cgroup/cpu.pressure',
  cgroupIoPressure: '/sys/fs/cgroup/io.pressure',
  cgroupMemoryPressure: '/sys/fs/cgroup/memory.pressure',
  cgroupIoStat: '/sys/fs/cgroup/io.stat',
  cgroupMemoryEvents: '/sys/fs/cgroup/memory.events',
  vmCpuPressure: '/proc/pressure/cpu',
  vmIoPressure: '/proc/pressure/io',
  vmMemoryPressure: '/proc/pressure/memory',
  vmStat: '/proc/stat',
  vmLoad: '/proc/loadavg',
};

export async function readResourceDiagnostics(read = readFile) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => {
        try {
          const value = await read(path, 'utf8');
          if (value.length > 32768) throw new Error('Diagnostic file exceeds bound');
          return [name, { available: true, value }];
        } catch {
          return [name, { available: false }];
        }
      }),
    ),
  );
}
