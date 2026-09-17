// WebKit-only fields of `DeviceOrientationEvent` on iOS Safari (plan D132 records this file,
// D118 the heading source it serves; brief l.546). lib.dom.d.ts
// declares `alpha`, `beta`, `gamma` and `absolute` only; WebKit adds the CoreLocation heading
// (`CLHeading.magneticHeading`, degrees clockwise from MAGNETIC north of the device top, 0 when
// unavailable) and its accuracy (`CLHeading.headingAccuracy`, degrees; -1 when unavailable, any
// negative value = invalid). Both are optional and nullable because every other browser omits
// them: `sky/ar/sensors.ts` reads them through `typeof === 'number'`. This file is a global
// declaration script (no import or export), so the interface merges with lib.dom's.

interface DeviceOrientationEvent {
  /** iOS Safari only: magnetic heading of the device top in degrees, `[0, 360)`; 0 when unavailable. */
  readonly webkitCompassHeading?: number | null;
  /** iOS Safari only: heading accuracy in degrees; negative (`-1` unavailable) means invalid. */
  readonly webkitCompassAccuracy?: number | null;
}
