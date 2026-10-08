import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaterialService } from "../src/main/services/materials/MaterialService.ts";

export function pngBytes(width, height, extra = 0) {
  const bytes = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function fakeWatch() {
  const listeners = new Map();
  return {
    factory(directory, listener) {
      listeners.set(directory, listener);
      return { close: () => listeners.delete(directory) };
    },
    fire(directory) {
      listeners.get(directory)?.();
    },
    directories: () => [...listeners.keys()]
  };
}

export async function withMaterials(run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvastty-materials-"));
  const work = join(root, "work");
  await mkdir(work);
  const userData = join(root, "user-data");
  const watch = fakeWatch();
  const snapshots = [];
  let persist = options.persist ?? true;
  const services = [];
  const create = () => {
    const config = {
      userDataPath: userData,
      persist: () => persist,
      emit: (snapshot) => snapshots.push(snapshot),
      watchFactory: watch.factory,
      pollIntervalMs: 0
    };
    if (options.storageLimitBytes !== undefined) config.storageLimitBytes = options.storageLimitBytes;
    if (options.scenarioLimitMs !== undefined) config.scenarioLimitMs = options.scenarioLimitMs;
    const rest = { ...options };
    delete rest.persist;
    delete rest.storageLimitBytes;
    delete rest.scenarioLimitMs;
    Object.assign(config, rest);
    const service = new MaterialService(config);
    services.push(service);
    const loading = service.load();
    return new Proxy(service, {
      get(target, prop) {
        if (prop === "then") {
          return (resolve, reject) => loading.then(() => resolve(target)).catch(reject);
        }
        return target[prop];
      }
    });
  };
  try {
    await run({ root, work: await realpath(work), userData, watch, snapshots, service: await create(), create, setPersist: (value) => { persist = value; } });
  } finally {
    for (const service of services) await service.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
