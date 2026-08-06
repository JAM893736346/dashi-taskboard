import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_AUTOMATIC_PROCESSING_SETTINGS,
  normalizeAutomaticProcessingSettings,
} from "../shared/automatic-processing.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createAutomaticProcessingConfigStore({ configPath }) {
  if (!configPath) throw new Error("configPath is required");
  let pendingWrite = Promise.resolve();

  async function readFromDisk() {
    try {
      return normalizeAutomaticProcessingSettings(
        JSON.parse(await readFile(configPath, "utf8")),
      );
    } catch (error) {
      if (error?.code === "ENOENT") return clone(DEFAULT_AUTOMATIC_PROCESSING_SETTINGS);
      throw error;
    }
  }

  return {
    async read() {
      await pendingWrite;
      return readFromDisk();
    },
    write(value) {
      const settings = normalizeAutomaticProcessingSettings(value);
      const operation = pendingWrite.catch(() => {}).then(async () => {
        await mkdir(path.dirname(configPath), { recursive: true });
        const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, configPath);
        return clone(settings);
      });
      pendingWrite = operation;
      return operation;
    },
  };
}
