import { SortedMap } from "sweet-collections";
const { parse } = require("date-and-time");

import { rootP2PLogger } from "../logging";
import { decodeImage } from "../http/utils";
import { parseJSON } from "../utils";
import { CmdDatabaseImageResponse } from "../p2p/models";
import {
  DatabaseCountByDate,
  DatabaseQueryByDate,
  DatabaseQueryLatestInfo,
  DatabaseQueryLocal,
  P2PDatabaseCountByDateResponse,
  P2PDatabaseDeleteResponse,
  P2PDatabaseQueryByDateRecord,
  P2PDatabaseQueryLatestInfoResponse,
  P2PDatabaseQueryLocalHistoryRecordInfo,
  P2PDatabaseQueryLocalRecordCropPictureInfo,
  P2PDatabaseQueryLocalResponse,
  P2PDatabaseResponse,
} from "../p2p/interfaces";
import { CommandType } from "../p2p/types";
import { PortalCommandResponse } from "./rtcPacket";

export interface StationDatabaseInboundSession {
  getStationSn(): string;
  emit(event: "database query latest", returnCode: number, data: Array<DatabaseQueryLatestInfo>): boolean;
  emit(event: "database query local", returnCode: number, data: Array<DatabaseQueryLocal>): boolean;
  emit(event: "database query by date", returnCode: number, data: Array<DatabaseQueryByDate>): boolean;
  emit(event: "database count by date", returnCode: number, data: Array<DatabaseCountByDate>): boolean;
  emit(event: "database delete", returnCode: number, failedIds: Array<unknown>): boolean;
  emit(event: "image download", file: string, image: Buffer): boolean;
}

function normalizeInboundJson(data: unknown): unknown {
  if (typeof data === "string") {
    return parseJSON(data, rootP2PLogger);
  }
  return data;
}

function extractDatabaseResponse(data: unknown): P2PDatabaseResponse | null {
  const normalized = normalizeInboundJson(data);
  if (typeof normalized !== "object" || normalized === null) {
    return null;
  }
  const obj = normalized as Record<string, unknown>;
  if (obj.mIntRet !== undefined && obj.cmd !== undefined) {
    return obj as unknown as P2PDatabaseResponse;
  }
  if (typeof obj.payload === "object" && obj.payload !== null) {
    const payload = obj.payload as Record<string, unknown>;
    if (payload.mIntRet !== undefined && payload.cmd !== undefined) {
      return payload as unknown as P2PDatabaseResponse;
    }
  }
  if (Number(obj.cmd) === CommandType.CMD_DATABASE && typeof obj.data !== "undefined") {
    return obj as unknown as P2PDatabaseResponse;
  }
  return null;
}

function extractDatabaseImageResponse(data: unknown): CmdDatabaseImageResponse | null {
  let normalized = normalizeInboundJson(data);
  if (Array.isArray(normalized) && normalized.length > 0) {
    normalized = normalized[0];
  }
  if (typeof normalized !== "object" || normalized === null) {
    return null;
  }
  const obj = normalized as Record<string, unknown>;
  if (typeof obj.file === "string" && typeof obj.content === "string") {
    return obj as unknown as CmdDatabaseImageResponse;
  }
  if (typeof obj.payload === "object" && obj.payload !== null) {
    const payload = obj.payload as Record<string, unknown>;
    if (typeof payload.file === "string" && typeof payload.content === "string") {
      return payload as unknown as CmdDatabaseImageResponse;
    }
  }
  return null;
}

export function handleStationDatabaseResponse(
  session: StationDatabaseInboundSession,
  databaseResponse: P2PDatabaseResponse
): boolean {
  try {
    switch (databaseResponse.cmd) {
      case CommandType.CMD_DATABASE_QUERY_LATEST_INFO: {
        let data: Array<P2PDatabaseQueryLatestInfoResponse> = [];
        if (databaseResponse.data !== undefined && (databaseResponse.data as unknown as string) !== "[]") {
          data = databaseResponse.data as Array<P2PDatabaseQueryLatestInfoResponse>;
        }
        const result: Array<DatabaseQueryLatestInfo> = [];
        for (const record of data) {
          if (record.payload.crop_hb3_path !== "") {
            result.push({
              device_sn: record.device_sn,
              event_count: record.payload.event_count,
              crop_local_path: record.payload.crop_hb3_path,
            });
          } else {
            result.push({
              device_sn: record.device_sn,
              event_count: record.payload.event_count,
              crop_cloud_path: record.payload.crop_cloud_path,
            });
          }
        }
        rootP2PLogger.info("RtcDatabase query latest", {
          stationSN: session.getStationSn(),
          returnCode: databaseResponse.mIntRet,
          devices: result.length,
        });
        session.emit("database query latest", databaseResponse.mIntRet, result);
        return true;
      }
      case CommandType.CMD_DATABASE_COUNT_BY_DATE: {
        let data: Array<P2PDatabaseCountByDateResponse> = [];
        if (databaseResponse.data !== undefined && (databaseResponse.data as unknown as string) !== "[]") {
          data = databaseResponse.data as Array<P2PDatabaseCountByDateResponse>;
        }
        const result: Array<DatabaseCountByDate> = [];
        for (const record of data) {
          result.push({
            day: parse(record.days, "YYYYMMDD"),
            count: record.count,
          });
        }
        session.emit("database count by date", databaseResponse.mIntRet, result);
        return true;
      }
      case CommandType.CMD_DATABASE_QUERY_LOCAL: {
        let data: Array<P2PDatabaseQueryLocalResponse> = [];
        if (databaseResponse.data !== undefined && (databaseResponse.data as unknown as string) !== "[]") {
          data = databaseResponse.data as Array<P2PDatabaseQueryLocalResponse>;
        }
        const result: SortedMap<number, Partial<DatabaseQueryLocal>> = new SortedMap<number, Partial<DatabaseQueryLocal>>(
          (a: number, b: number) => a - b
        );
        for (const record of data) {
          for (const tableRecord of record.payload) {
            let tmpRecord = result.get(tableRecord.record_id);
            if (tmpRecord === undefined) {
              tmpRecord = {
                record_id: tableRecord.record_id,
                device_sn: tableRecord.device_sn,
                station_sn: tableRecord.station_sn,
              };
            }
            if (record.table_name === "history_record_info") {
              tmpRecord.history = {
                device_type: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).device_type,
                account: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).account,
                start_time: parse(
                  (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).start_time,
                  "YYYY-MM-DD HH:mm:ss"
                ),
                end_time: parse(
                  (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).end_time,
                  "YYYY-MM-DD HH:mm:ss"
                ),
                frame_num: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).frame_num,
                storage_type: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).storage_type,
                storage_cloud: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).storage_cloud,
                cipher_id: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).cipher_id,
                vision: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).vision,
                video_type: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).video_type,
                has_lock: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).has_lock,
                automation_id: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).automation_id,
                trigger_type: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).trigger_type,
                push_mode: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).push_mode,
                mic_status: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).mic_status,
                res_change: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).res_change,
                res_best_width: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).res_best_width,
                res_best_height: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).res_best_height,
                self_learning: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).self_learning,
                storage_path: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).storage_path,
                thumb_path: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).thumb_path,
                write_status: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).write_status,
                cloud_path: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).cloud_path,
                folder_size: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).folder_size,
                storage_status: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).storage_status,
                storage_label: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).storage_label,
                time_zone: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).time_zone,
                mp4_cloud: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).mp4_cloud,
                snapshot_cloud: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).snapshot_cloud,
                table_version: (tableRecord as P2PDatabaseQueryLocalHistoryRecordInfo).table_version,
              };
            } else if (record.table_name === "record_crop_picture_info") {
              if (tmpRecord.picture === undefined) {
                tmpRecord.picture = [];
              }
              tmpRecord.picture.push({
                picture_id: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).picture_id,
                detection_type: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).detection_type,
                person_id: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).person_id,
                crop_path: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).crop_path,
                event_time: parse(
                  (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).event_time,
                  "YYYY-MM-DD HH:mm:ss"
                ),
                person_recog_flag: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).person_recog_flag,
                crop_pic_quality: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).crop_pic_quality,
                pic_marking_flag: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).pic_marking_flag,
                group_id: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).group_id,
                crop_id: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).crop_id,
                start_time: parse(
                  (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).start_time,
                  "YYYY-MM-DD HH:mm:ss"
                ),
                storage_type: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).storage_type,
                storage_status: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).storage_status,
                storage_label: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).storage_label,
                table_version: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).table_version,
                update_time: (tableRecord as P2PDatabaseQueryLocalRecordCropPictureInfo).update_time,
              });
            }
            result.set(tableRecord.record_id, tmpRecord);
          }
        }
        session.emit(
          "database query local",
          databaseResponse.mIntRet,
          Array.from(result.values()) as DatabaseQueryLocal[]
        );
        return true;
      }
      case CommandType.CMD_DATABASE_QUERY_BY_DATE: {
        let data: Array<P2PDatabaseQueryByDateRecord> = [];
        if (databaseResponse.data !== undefined && (databaseResponse.data as unknown as string) !== "[]") {
          data = databaseResponse.data as unknown as Array<P2PDatabaseQueryByDateRecord>;
        }
        const result: Array<DatabaseQueryByDate> = [];
        for (const record of data) {
          result.push({
            device_sn: record.device_sn,
            device_type: record.device_type,
            start_time: parse(record.start_time, "YYYY-MM-DD HH:mm:ss"),
            end_time: parse(record.end_time, "YYYY-MM-DD HH:mm:ss"),
            storage_path: record.storage_path,
            thumb_path: record.thumb_path,
            cipher_id: record.cipher_id,
            folder_size: record.folder_size,
            frame_num: record.frame_num,
            trigger_type: record.trigger_type,
            video_type: record.video_type,
            record_id: record.record_id,
            station_sn: record.station_sn,
            storage_type: record.storage_type,
            storage_cloud: record.storage_cloud,
          });
        }
        session.emit("database query by date", databaseResponse.mIntRet, result);
        return true;
      }
      case CommandType.CMD_DATABASE_DELETE: {
        const data = databaseResponse.data as P2PDatabaseDeleteResponse;
        let failed_delete: Array<unknown> = [];
        if (databaseResponse.data !== undefined && (data.failed_delete as unknown as string) !== "[]") {
          failed_delete = data.failed_delete;
        }
        session.emit("database delete", databaseResponse.mIntRet, failed_delete);
        return true;
      }
      default:
        rootP2PLogger.debug("RtcDatabase unhandled database cmd", {
          stationSN: session.getStationSn(),
          cmd: databaseResponse.cmd,
        });
        return false;
    }
  } catch (err) {
    rootP2PLogger.error("RtcDatabase handle database response error", {
      stationSN: session.getStationSn(),
      cmd: databaseResponse.cmd,
      error: err,
    });
    return false;
  }
}

export function handleStationDatabaseImageResponse(
  session: StationDatabaseInboundSession,
  p2pDid: string | undefined,
  imageResponse: CmdDatabaseImageResponse
): boolean {
  if (!p2pDid) {
    rootP2PLogger.warn("RtcDatabase image download missing p2p_did", {
      stationSN: session.getStationSn(),
      file: imageResponse.file,
    });
    return false;
  }
  try {
    rootP2PLogger.info("RtcDatabase image download", {
      stationSN: session.getStationSn(),
      file: imageResponse.file,
      bytes: imageResponse.content.length,
    });
    session.emit(
      "image download",
      imageResponse.file,
      decodeImage(p2pDid, Buffer.from(imageResponse.content, "base64"))
    );
    return true;
  } catch (err) {
    rootP2PLogger.error("RtcDatabase image download error", {
      stationSN: session.getStationSn(),
      file: imageResponse.file,
      error: err,
    });
    return false;
  }
}

/** Route portal/RTC payloads into the legacy database + image download event pipeline. */
export function dispatchPortalDatabaseInbound(
  session: StationDatabaseInboundSession,
  p2pDid: string | undefined,
  parsed?: PortalCommandResponse | null,
  rawData?: unknown,
  commandID?: number
): boolean {
  const data = parsed?.data ?? rawData;
  if (data === undefined) {
    return false;
  }

  const topCommand = commandID ?? parsed?.commandID ?? parsed?.cmd;
  if (topCommand === CommandType.CMD_DATABASE_IMAGE) {
    const image = extractDatabaseImageResponse(data);
    return image ? handleStationDatabaseImageResponse(session, p2pDid, image) : false;
  }

  const database = extractDatabaseResponse(data);
  if (database) {
    return handleStationDatabaseResponse(session, database);
  }

  if (topCommand === CommandType.CMD_DATABASE) {
    const databaseFromCmd = extractDatabaseResponse({ cmd: CommandType.CMD_DATABASE, ...(data as object) });
    if (databaseFromCmd) {
      return handleStationDatabaseResponse(session, databaseFromCmd);
    }
  }

  const image = extractDatabaseImageResponse(data);
  if (image) {
    return handleStationDatabaseImageResponse(session, p2pDid, image);
  }

  return false;
}
