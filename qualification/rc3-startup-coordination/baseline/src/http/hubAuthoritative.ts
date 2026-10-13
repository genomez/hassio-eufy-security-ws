import { CommandType } from "../p2p/types";
import { ParamType, PropertyName, SourceType } from "./types";

/** Defer cloud refresh until after hub polls complete (reconnect, hub notify, periodic refresh). */
export const HUB_FIRST_CLOUD_REFRESH_DELAY_MS = 8000;

/**
 * Live operational state the hub reports authoritatively (RTC push, camera info poll, DB query).
 * Cloud device/station list values for these are often stale — especially after local HA control.
 */
export const HUB_AUTHORITATIVE_DEVICE_HTTP_PARAMS: ReadonlySet<number> = new Set([
  CommandType.CMD_SET_FLOODLIGHT_MANUAL_SWITCH,
]);

export const HUB_AUTHORITATIVE_DEVICE_CLOUD_PROPERTIES: ReadonlySet<string> = new Set([
  PropertyName.DeviceLight,
  PropertyName.DeviceMotionDetected,
  PropertyName.DevicePersonDetected,
  PropertyName.DevicePetDetected,
  PropertyName.DeviceSoundDetected,
  PropertyName.DeviceCryingDetected,
  PropertyName.DeviceVehicleDetected,
  PropertyName.DeviceIdentityPersonDetected,
  PropertyName.DeviceStrangerPersonDetected,
  PropertyName.DeviceDogDetected,
  PropertyName.DeviceDogLickDetected,
  PropertyName.DeviceDogPoopDetected,
]);

export const HUB_AUTHORITATIVE_STATION_HTTP_PARAMS: ReadonlySet<number> = new Set([
  ParamType.GUARD_MODE,
  CommandType.CMD_GET_ALARM_MODE,
]);

export const HUB_AUTHORITATIVE_STATION_CLOUD_PROPERTIES: ReadonlySet<string> = new Set([
  PropertyName.StationGuardMode,
  PropertyName.StationCurrentMode,
]);

export function isHubAuthoritativeDeviceHttpParam(paramType: number, source: SourceType): boolean {
  return source === "http" && HUB_AUTHORITATIVE_DEVICE_HTTP_PARAMS.has(paramType);
}

export function isHubAuthoritativeDeviceCloudProperty(propertyName: string): boolean {
  return HUB_AUTHORITATIVE_DEVICE_CLOUD_PROPERTIES.has(propertyName);
}

export function isHubAuthoritativeStationHttpParam(
  paramType: number,
  source: SourceType,
  hubConnected: boolean
): boolean {
  return hubConnected && source === "http" && HUB_AUTHORITATIVE_STATION_HTTP_PARAMS.has(paramType);
}

export function isHubAuthoritativeStationCloudProperty(propertyName: string, hubConnected: boolean): boolean {
  return hubConnected && HUB_AUTHORITATIVE_STATION_CLOUD_PROPERTIES.has(propertyName);
}
