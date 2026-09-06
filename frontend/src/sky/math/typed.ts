// Numeric idiom of the pure sky mathematics (plan D71).
//
// Values are fixed tuples (`Vec3`, `Quat`), bulk storage is typed arrays. Under
// `noUncheckedIndexedAccess` a typed-array read is `number | undefined` and the project forbids
// `!` and `as number`, so reads go through `at()`, which throws on an out-of-range index instead
// of hiding a bug behind a `?? 0` fallback. Every kernel writes into an `out` parameter and
// returns it: nothing here allocates in a hot path.

/** A 3-vector `[x, y, z]`. */
export type Vec3 = [number, number, number];
export type ReadonlyVec3 = readonly [number, number, number];

/** A unit quaternion `[x, y, z, w]` (Hamilton convention, `v' = q v q^-1`). */
export type Quat = [number, number, number, number];
export type ReadonlyQuat = readonly [number, number, number, number];

/** Read `a[i]`, throwing `RangeError` when the index is outside the array. */
export function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) {
    throw new RangeError(`index ${String(i)} out of range for length ${String(a.length)}`);
  }
  return v;
}

/** Load three consecutive values `a[offset..offset+2]` into `out`. */
export function load3(out: Vec3, a: ArrayLike<number>, offset: number): Vec3 {
  out[0] = at(a, offset);
  out[1] = at(a, offset + 1);
  out[2] = at(a, offset + 2);
  return out;
}

/** Load four consecutive values `a[offset..offset+3]` into `out`. */
export function load4(out: Quat, a: ArrayLike<number>, offset: number): Quat {
  out[0] = at(a, offset);
  out[1] = at(a, offset + 1);
  out[2] = at(a, offset + 2);
  out[3] = at(a, offset + 3);
  return out;
}

/** Store `v` at `dst[offset..offset+2]`. */
export function store3(dst: Float32Array | Float64Array, offset: number, v: ReadonlyVec3): void {
  dst[offset] = v[0];
  dst[offset + 1] = v[1];
  dst[offset + 2] = v[2];
}

/** Store `q` at `dst[offset..offset+3]`. */
export function store4(dst: Float32Array | Float64Array, offset: number, q: ReadonlyQuat): void {
  dst[offset] = q[0];
  dst[offset + 1] = q[1];
  dst[offset + 2] = q[2];
  dst[offset + 3] = q[3];
}

/** A fresh zero `Vec3` (for preallocation outside hot paths). */
export function vec3(): Vec3 {
  return [0, 0, 0];
}

/** A fresh identity `Quat` (for preallocation outside hot paths). */
export function quat(): Quat {
  return [0, 0, 0, 1];
}
