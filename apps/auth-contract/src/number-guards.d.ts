// Number.isFinite / Number.isInteger as type guards. lib.es2015 types them as
// `(number: unknown) => boolean`, which doesn't narrow — so guarding nullable
// numbers positively (`if (Number.isFinite(x))`, the escape hatch
// iterate/simple-truthiness-check suggests when 0 is meaningful) would force a
// non-null assertion at every subsequent use. Merged later than the lib
// declaration, so these predicate signatures win overload resolution.
//
// The negative branch is deliberately "unsound": a NaN/Infinity number narrows
// away from `number` there, which matches how this codebase treats those
// values — as absent.
interface NumberConstructor {
  isFinite(value: unknown): value is number;
  isInteger(value: unknown): value is number;
}
