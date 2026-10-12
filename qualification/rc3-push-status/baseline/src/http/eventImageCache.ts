import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import { rootMainLogger } from "../logging";
import { Picture } from "./interfaces";

interface EventImageMeta {
  file: string;
  mime: string;
  ext: string;
  updatedAt: number;
}

/** Persist last event thumbnails under the add-on /data directory. */
export class EventImageCache {
  private readonly dir: string;

  constructor(persistentDir: string) {
    this.dir = path.join(persistentDir, "event_images");
    mkdirSync(this.dir, { recursive: true });
  }

  public save(deviceSn: string, file: string, picture: Picture): void {
    if (!deviceSn || !picture.data?.length) {
      return;
    }
    const ext = picture.type.ext && picture.type.ext !== "unknown" ? picture.type.ext : "jpg";
    const meta: EventImageMeta = {
      file,
      mime: picture.type.mime,
      ext,
      updatedAt: Date.now(),
    };
    try {
      writeFileSync(path.join(this.dir, `${deviceSn}.${ext}`), picture.data);
      writeFileSync(path.join(this.dir, `${deviceSn}.meta.json`), JSON.stringify(meta));
      rootMainLogger.debug("EventImageCache saved", { deviceSn, file, bytes: picture.data.length, ext });
    } catch (err) {
      rootMainLogger.warn("EventImageCache save failed", {
        deviceSn,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public load(deviceSn: string): { file: string; picture: Picture } | undefined {
    const metaPath = path.join(this.dir, `${deviceSn}.meta.json`);
    if (!existsSync(metaPath)) {
      return undefined;
    }
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as EventImageMeta;
      const imagePath = path.join(this.dir, `${deviceSn}.${meta.ext}`);
      if (!existsSync(imagePath)) {
        return undefined;
      }
      const data = readFileSync(imagePath);
      return {
        file: meta.file,
        picture: {
          data,
          type: {
            ext: meta.ext as Picture["type"]["ext"],
            mime: meta.mime,
          },
        },
      };
    } catch (err) {
      rootMainLogger.debug("EventImageCache load failed", {
        deviceSn,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
}
