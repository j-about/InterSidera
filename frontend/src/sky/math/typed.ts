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

/**
 * Read `a[i]`, throwing `RangeError` when the index is outside the array.
 *
 * Kept as one tiny load site (plan D144): `at` is called with every typed-array kind of the
 * application plus plain arrays, so its keyed load is megamorphic and V8's generic path boxes
 * every double it returns; splitting it into one site per receiver family was measured on the M6
 * heap protocol and changed nothing (about 45 kB per overlay tick either way), so the hot kernels
 * read consecutive values through `load3`/`load4` below, whose own load sites see the two float
 * families only, and the residual `at` rows are recorded with the heap table (backlog B-91).
 */
export function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) {
    throw new RangeError(`index ${String(i)} out of range for length ${String(a.length)}`);
  }
  return v;
}

/**
 * Load three consecutive values `a[offset..offset+2]` into `out`, throwing `RangeError` when any
 * of them is outside the array. The reads are `load3`'s own (plan D144): the catalog columns are
 * `Float32Array`, the frame buffers `Float64Array`, so the load site stays polymorphic and the
 * doubles reach `out` unboxed, where `at` (every receiver kind of the application) would box them.
 */
export function load3(out: Vec3, a: ArrayLike<number>, offset: number): Vec3 {
  const x = a[offset];
  const y = a[offset + 1];
  const z = a[offset + 2];
  if (x === undefined || y === undefined || z === undefined) {
    throw new RangeError(
      `indices ${String(offset)}..${String(offset + 2)} out of range for length ${String(a.length)}`,
    );
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/** Load four consecutive values `a[offset..offset+3]` into `out` (the `load3` rule). */
export function load4(out: Quat, a: ArrayLike<number>, offset: number): Quat {
  const x = a[offset];
  const y = a[offset + 1];
  const z = a[offset + 2];
  const w = a[offset + 3];
  if (x === undefined || y === undefined || z === undefined || w === undefined) {
    throw new RangeError(
      `indices ${String(offset)}..${String(offset + 3)} out of range for length ${String(a.length)}`,
    );
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
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
