import dedent from "dedent";
import z$1, { z } from "zod";

//#region backend/utils/type-helpers.d.ts
type JSONSerializable = {} | null | undefined;
declare const JSONSerializable: z.ZodType<JSONSerializable>;
//#endregion
//#region backend/agent/prompt-fragments.d.ts
type PromptFragment = null | string | {
  tag?: string;
  content: PromptFragment | PromptFragment[];
} | PromptFragment[];
declare const PromptFragment: z.ZodType<PromptFragment>;
/**
 * Create a prompt fragment with an optional XML tag wrapper.
 * This is a utility function for creating structured prompt fragments.
 *
 * @param tag - The XML tag name to wrap the content
 * @param content - The fragment content(s) - can be strings, objects, or arrays
 * @returns A PromptFragmentObject with the specified tag and content
 *
 * @example
 * // Simple fragment
 * f("role", "You are a helpful assistant")
 *
 * // Nested fragments
 * f("rules",
 *   "Follow these guidelines:",
 *   f("important", "Be concise"),
 *   f("important", "Be accurate")
 * )
 */
declare function f(tag: string, ...content: PromptFragment[]): z.infer<typeof PromptFragment>;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/is-any.d.ts
/**
Returns a boolean for whether the given type is `any`.

@link https://stackoverflow.com/a/49928360/1490091

Useful in type utilities, such as disallowing `any`s to be passed to a function.

@example
```
import type {IsAny} from 'type-fest';

const typedObject = {a: 1, b: 2} as const;
const anyObject: any = {a: 1, b: 2};

function get<O extends (IsAny<O> extends true ? {} : Record<string, number>), K extends keyof O = keyof O>(obj: O, key: K) {
	return obj[key];
}

const typedA = get(typedObject, 'a');
//=> 1

const anyA = get(anyObject, 'a');
//=> any
```

@category Type Guard
@category Utilities
*/
type IsAny<T> = 0 extends 1 & NoInfer<T> ? true : false;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/is-optional-key-of.d.ts
/**
Returns a boolean for whether the given key is an optional key of type.

This is useful when writing utility types or schema validators that need to differentiate `optional` keys.

@example
```
import type {IsOptionalKeyOf} from 'type-fest';

interface User {
	name: string;
	surname: string;

	luckyNumber?: number;
}

interface Admin {
	name: string;
	surname?: string;
}

type T1 = IsOptionalKeyOf<User, 'luckyNumber'>;
//=> true

type T2 = IsOptionalKeyOf<User, 'name'>;
//=> false

type T3 = IsOptionalKeyOf<User, 'name' | 'luckyNumber'>;
//=> boolean

type T4 = IsOptionalKeyOf<User | Admin, 'name'>;
//=> false

type T5 = IsOptionalKeyOf<User | Admin, 'surname'>;
//=> boolean
```

@category Type Guard
@category Utilities
*/
type IsOptionalKeyOf<Type extends object, Key$1 extends keyof Type> = IsAny<Type | Key$1> extends true ? never : Key$1 extends keyof Type ? Type extends Record<Key$1, Type[Key$1]> ? false : true : false;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/optional-keys-of.d.ts
/**
Extract all optional keys from the given type.

This is useful when you want to create a new type that contains different type values for the optional keys only.

@example
```
import type {OptionalKeysOf, Except} from 'type-fest';

interface User {
	name: string;
	surname: string;

	luckyNumber?: number;
}

const REMOVE_FIELD = Symbol('remove field symbol');
type UpdateOperation<Entity extends object> = Except<Partial<Entity>, OptionalKeysOf<Entity>> & {
	[Key in OptionalKeysOf<Entity>]?: Entity[Key] | typeof REMOVE_FIELD;
};

const update1: UpdateOperation<User> = {
	name: 'Alice'
};

const update2: UpdateOperation<User> = {
	name: 'Bob',
	luckyNumber: REMOVE_FIELD
};
```

@category Utilities
*/
type OptionalKeysOf<Type extends object> = Type extends unknown // For distributing `Type`
? (keyof { [Key in keyof Type as IsOptionalKeyOf<Type, Key> extends false ? never : Key]: never }) & keyof Type // Intersect with `keyof Type` to ensure result of `OptionalKeysOf<Type>` is always assignable to `keyof Type`
: never;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/required-keys-of.d.ts
/**
Extract all required keys from the given type.

This is useful when you want to create a new type that contains different type values for the required keys only or use the list of keys for validation purposes, etc...

@example
```
import type {RequiredKeysOf} from 'type-fest';

declare function createValidation<Entity extends object, Key extends RequiredKeysOf<Entity> = RequiredKeysOf<Entity>>(field: Key, validator: (value: Entity[Key]) => boolean): ValidatorFn;

interface User {
	name: string;
	surname: string;

	luckyNumber?: number;
}

const validator1 = createValidation<User>('name', value => value.length < 25);
const validator2 = createValidation<User>('surname', value => value.length < 25);
```

@category Utilities
*/
type RequiredKeysOf<Type extends object> = Type extends unknown // For distributing `Type`
? Exclude<keyof Type, OptionalKeysOf<Type>> : never;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/is-never.d.ts
/**
Returns a boolean for whether the given type is `never`.

@link https://github.com/microsoft/TypeScript/issues/31751#issuecomment-498526919
@link https://stackoverflow.com/a/53984913/10292952
@link https://www.zhenghao.io/posts/ts-never

Useful in type utilities, such as checking if something does not occur.

@example
```
import type {IsNever, And} from 'type-fest';

// https://github.com/andnp/SimplyTyped/blob/master/src/types/strings.ts
type AreStringsEqual<A extends string, B extends string> =
	And<
		IsNever<Exclude<A, B>> extends true ? true : false,
		IsNever<Exclude<B, A>> extends true ? true : false
	>;

type EndIfEqual<I extends string, O extends string> =
	AreStringsEqual<I, O> extends true
		? never
		: void;

function endIfEqual<I extends string, O extends string>(input: I, output: O): EndIfEqual<I, O> {
	if (input === output) {
		process.exit(0);
	}
}

endIfEqual('abc', 'abc');
//=> never

endIfEqual('abc', '123');
//=> void
```

@category Type Guard
@category Utilities
*/
type IsNever<T> = [T] extends [never] ? true : false;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/if.d.ts
/**
An if-else-like type that resolves depending on whether the given `boolean` type is `true` or `false`.

Use-cases:
- You can use this in combination with `Is*` types to create an if-else-like experience. For example, `If<IsAny<any>, 'is any', 'not any'>`.

Note:
- Returns a union of if branch and else branch if the given type is `boolean` or `any`. For example, `If<boolean, 'Y', 'N'>` will return `'Y' | 'N'`.
- Returns the else branch if the given type is `never`. For example, `If<never, 'Y', 'N'>` will return `'N'`.

@example
```
import {If} from 'type-fest';

type A = If<true, 'yes', 'no'>;
//=> 'yes'

type B = If<false, 'yes', 'no'>;
//=> 'no'

type C = If<boolean, 'yes', 'no'>;
//=> 'yes' | 'no'

type D = If<any, 'yes', 'no'>;
//=> 'yes' | 'no'

type E = If<never, 'yes', 'no'>;
//=> 'no'
```

@example
```
import {If, IsAny, IsNever} from 'type-fest';

type A = If<IsAny<unknown>, 'is any', 'not any'>;
//=> 'not any'

type B = If<IsNever<never>, 'is never', 'not never'>;
//=> 'is never'
```

@example
```
import {If, IsEqual} from 'type-fest';

type IfEqual<T, U, IfBranch, ElseBranch> = If<IsEqual<T, U>, IfBranch, ElseBranch>;

type A = IfEqual<string, string, 'equal', 'not equal'>;
//=> 'equal'

type B = IfEqual<string, number, 'equal', 'not equal'>;
//=> 'not equal'
```

Note: Sometimes using the `If` type can make an implementation non–tail-recursive, which can impact performance. In such cases, it’s better to use a conditional directly. Refer to the following example:

@example
```
import type {If, IsEqual, StringRepeat} from 'type-fest';

type HundredZeroes = StringRepeat<'0', 100>;

// The following implementation is not tail recursive
type Includes<S extends string, Char extends string> =
	S extends `${infer First}${infer Rest}`
		? If<IsEqual<First, Char>,
			'found',
			Includes<Rest, Char>>
		: 'not found';

// Hence, instantiations with long strings will fail
// @ts-expect-error
type Fails = Includes<HundredZeroes, '1'>;
//           ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Error: Type instantiation is excessively deep and possibly infinite.

// However, if we use a simple conditional instead of `If`, the implementation becomes tail-recursive
type IncludesWithoutIf<S extends string, Char extends string> =
	S extends `${infer First}${infer Rest}`
		? IsEqual<First, Char> extends true
			? 'found'
			: IncludesWithoutIf<Rest, Char>
		: 'not found';

// Now, instantiations with long strings will work
type Works = IncludesWithoutIf<HundredZeroes, '1'>;
//=> 'not found'
```

@category Type Guard
@category Utilities
*/
type If<Type extends boolean, IfBranch, ElseBranch> = IsNever<Type> extends true ? ElseBranch : Type extends true ? IfBranch : ElseBranch;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/internal/type.d.ts

/**
An if-else-like type that resolves depending on whether the given type is `any` or `never`.

@example
```
// When `T` is a NOT `any` or `never` (like `string`) => Returns `IfNotAnyOrNever` branch
type A = IfNotAnyOrNever<string, 'VALID', 'IS_ANY', 'IS_NEVER'>;
//=> 'VALID'

// When `T` is `any` => Returns `IfAny` branch
type B = IfNotAnyOrNever<any, 'VALID', 'IS_ANY', 'IS_NEVER'>;
//=> 'IS_ANY'

// When `T` is `never` => Returns `IfNever` branch
type C = IfNotAnyOrNever<never, 'VALID', 'IS_ANY', 'IS_NEVER'>;
//=> 'IS_NEVER'
```

Note: Wrapping a tail-recursive type with `IfNotAnyOrNever` makes the implementation non-tail-recursive. To fix this, move the recursion into a helper type. Refer to the following example:

@example
```ts
import type {StringRepeat} from 'type-fest';

type NineHundredNinetyNineSpaces = StringRepeat<' ', 999>;

// The following implementation is not tail recursive
type TrimLeft<S extends string> = IfNotAnyOrNever<S, S extends ` ${infer R}` ? TrimLeft<R> : S>;

// Hence, instantiations with long strings will fail
// @ts-expect-error
type T1 = TrimLeft<NineHundredNinetyNineSpaces>;
//        ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Error: Type instantiation is excessively deep and possibly infinite.

// To fix this, move the recursion into a helper type
type TrimLeftOptimised<S extends string> = IfNotAnyOrNever<S, _TrimLeftOptimised<S>>;

type _TrimLeftOptimised<S extends string> = S extends ` ${infer R}` ? _TrimLeftOptimised<R> : S;

type T2 = TrimLeftOptimised<NineHundredNinetyNineSpaces>;
//=> ''
```
*/
type IfNotAnyOrNever<T, IfNotAnyOrNever$1, IfAny = any, IfNever = never> = If<IsAny<T>, IfAny, If<IsNever<T>, IfNever, IfNotAnyOrNever$1>>;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/simplify.d.ts
/**
Useful to flatten the type output to improve type hints shown in editors. And also to transform an interface into a type to aide with assignability.

@example
```
import type {Simplify} from 'type-fest';

type PositionProps = {
	top: number;
	left: number;
};

type SizeProps = {
	width: number;
	height: number;
};

// In your editor, hovering over `Props` will show a flattened object with all the properties.
type Props = Simplify<PositionProps & SizeProps>;
```

Sometimes it is desired to pass a value as a function argument that has a different type. At first inspection it may seem assignable, and then you discover it is not because the `value`'s type definition was defined as an interface. In the following example, `fn` requires an argument of type `Record<string, unknown>`. If the value is defined as a literal, then it is assignable. And if the `value` is defined as type using the `Simplify` utility the value is assignable.  But if the `value` is defined as an interface, it is not assignable because the interface is not sealed and elsewhere a non-string property could be added to the interface.

If the type definition must be an interface (perhaps it was defined in a third-party npm package), then the `value` can be defined as `const value: Simplify<SomeInterface> = ...`. Then `value` will be assignable to the `fn` argument.  Or the `value` can be cast as `Simplify<SomeInterface>` if you can't re-declare the `value`.

@example
```
import type {Simplify} from 'type-fest';

interface SomeInterface {
	foo: number;
	bar?: string;
	baz: number | undefined;
}

type SomeType = {
	foo: number;
	bar?: string;
	baz: number | undefined;
};

const literal = {foo: 123, bar: 'hello', baz: 456};
const someType: SomeType = literal;
const someInterface: SomeInterface = literal;

function fn(object: Record<string, unknown>): void {}

fn(literal); // Good: literal object type is sealed
fn(someType); // Good: type is sealed
fn(someInterface); // Error: Index signature for type 'string' is missing in type 'someInterface'. Because `interface` can be re-opened
fn(someInterface as Simplify<SomeInterface>); // Good: transform an `interface` into a `type`
```

@link https://github.com/microsoft/TypeScript/issues/15300
@see {@link SimplifyDeep}
@category Object
*/
type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/is-equal.d.ts
/**
Returns a boolean for whether the two given types are equal.

@link https://github.com/microsoft/TypeScript/issues/27024#issuecomment-421529650
@link https://stackoverflow.com/questions/68961864/how-does-the-equals-work-in-typescript/68963796#68963796

Use-cases:
- If you want to make a conditional branch based on the result of a comparison of two types.

@example
```
import type {IsEqual} from 'type-fest';

// This type returns a boolean for whether the given array includes the given item.
// `IsEqual` is used to compare the given array at position 0 and the given item and then return true if they are equal.
type Includes<Value extends readonly any[], Item> =
	Value extends readonly [Value[0], ...infer rest]
		? IsEqual<Value[0], Item> extends true
			? true
			: Includes<rest, Item>
		: false;
```

@category Type Guard
@category Utilities
*/
type IsEqual<A$1, B$1> = [A$1, B$1] extends [infer AA, infer BB] ? [AA] extends [never] ? [BB] extends [never] ? true : false : [BB] extends [never] ? false : _IsEqual<AA, BB> : false;
// This version fails the `equalWrappedTupleIntersectionToBeNeverAndNeverExpanded` test in `test-d/is-equal.ts`.
type _IsEqual<A$1, B$1> = (<G>() => G extends A$1 & G | G ? 1 : 2) extends (<G>() => G extends B$1 & G | G ? 1 : 2) ? true : false;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/omit-index-signature.d.ts
/**
Omit any index signatures from the given object type, leaving only explicitly defined properties.

This is the counterpart of `PickIndexSignature`.

Use-cases:
- Remove overly permissive signatures from third-party types.

This type was taken from this [StackOverflow answer](https://stackoverflow.com/a/68261113/420747).

It relies on the fact that an empty object (`{}`) is assignable to an object with just an index signature, like `Record<string, unknown>`, but not to an object with explicitly defined keys, like `Record<'foo' | 'bar', unknown>`.

(The actual value type, `unknown`, is irrelevant and could be any type. Only the key type matters.)

```
const indexed: Record<string, unknown> = {}; // Allowed

const keyed: Record<'foo', unknown> = {}; // Error
// => TS2739: Type '{}' is missing the following properties from type 'Record<"foo" | "bar", unknown>': foo, bar
```

Instead of causing a type error like the above, you can also use a [conditional type](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html) to test whether a type is assignable to another:

```
type Indexed = {} extends Record<string, unknown>
	? '✅ `{}` is assignable to `Record<string, unknown>`'
	: '❌ `{}` is NOT assignable to `Record<string, unknown>`';
// => '✅ `{}` is assignable to `Record<string, unknown>`'

type Keyed = {} extends Record<'foo' | 'bar', unknown>
	? "✅ `{}` is assignable to `Record<'foo' | 'bar', unknown>`"
	: "❌ `{}` is NOT assignable to `Record<'foo' | 'bar', unknown>`";
// => "❌ `{}` is NOT assignable to `Record<'foo' | 'bar', unknown>`"
```

Using a [mapped type](https://www.typescriptlang.org/docs/handbook/2/mapped-types.html#further-exploration), you can then check for each `KeyType` of `ObjectType`...

```
import type {OmitIndexSignature} from 'type-fest';

type OmitIndexSignature<ObjectType> = {
	[KeyType in keyof ObjectType // Map each key of `ObjectType`...
	]: ObjectType[KeyType]; // ...to its original value, i.e. `OmitIndexSignature<Foo> == Foo`.
};
```

...whether an empty object (`{}`) would be assignable to an object with that `KeyType` (`Record<KeyType, unknown>`)...

```
import type {OmitIndexSignature} from 'type-fest';

type OmitIndexSignature<ObjectType> = {
	[KeyType in keyof ObjectType
		// Is `{}` assignable to `Record<KeyType, unknown>`?
		as {} extends Record<KeyType, unknown>
			? ... // ✅ `{}` is assignable to `Record<KeyType, unknown>`
			: ... // ❌ `{}` is NOT assignable to `Record<KeyType, unknown>`
	]: ObjectType[KeyType];
};
```

If `{}` is assignable, it means that `KeyType` is an index signature and we want to remove it. If it is not assignable, `KeyType` is a "real" key and we want to keep it.

@example
```
import type {OmitIndexSignature} from 'type-fest';

interface Example {
	// These index signatures will be removed.
	[x: string]: any
	[x: number]: any
	[x: symbol]: any
	[x: `head-${string}`]: string
	[x: `${string}-tail`]: string
	[x: `head-${string}-tail`]: string
	[x: `${bigint}`]: string
	[x: `embedded-${number}`]: string

	// These explicitly defined keys will remain.
	foo: 'bar';
	qux?: 'baz';
}

type ExampleWithoutIndexSignatures = OmitIndexSignature<Example>;
// => { foo: 'bar'; qux?: 'baz' | undefined; }
```

@see {@link PickIndexSignature}
@category Object
*/
type OmitIndexSignature<ObjectType> = { [KeyType in keyof ObjectType as {} extends Record<KeyType, unknown> ? never : KeyType]: ObjectType[KeyType] };
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/pick-index-signature.d.ts
/**
Pick only index signatures from the given object type, leaving out all explicitly defined properties.

This is the counterpart of `OmitIndexSignature`.

@example
```
import type {PickIndexSignature} from 'type-fest';

declare const symbolKey: unique symbol;

type Example = {
	// These index signatures will remain.
	[x: string]: unknown;
	[x: number]: unknown;
	[x: symbol]: unknown;
	[x: `head-${string}`]: string;
	[x: `${string}-tail`]: string;
	[x: `head-${string}-tail`]: string;
	[x: `${bigint}`]: string;
	[x: `embedded-${number}`]: string;

	// These explicitly defined keys will be removed.
	['kebab-case-key']: string;
	[symbolKey]: string;
	foo: 'bar';
	qux?: 'baz';
};

type ExampleIndexSignature = PickIndexSignature<Example>;
// {
// 	[x: string]: unknown;
// 	[x: number]: unknown;
// 	[x: symbol]: unknown;
// 	[x: `head-${string}`]: string;
// 	[x: `${string}-tail`]: string;
// 	[x: `head-${string}-tail`]: string;
// 	[x: `${bigint}`]: string;
// 	[x: `embedded-${number}`]: string;
// }
```

@see {@link OmitIndexSignature}
@category Object
*/
type PickIndexSignature<ObjectType> = { [KeyType in keyof ObjectType as {} extends Record<KeyType, unknown> ? KeyType : never]: ObjectType[KeyType] };
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/merge.d.ts
// Merges two objects without worrying about index signatures.
type SimpleMerge<Destination, Source> = { [Key in keyof Destination as Key extends keyof Source ? never : Key]: Destination[Key] } & Source;

/**
Merge two types into a new type. Keys of the second type overrides keys of the first type.

@example
```
import type {Merge} from 'type-fest';

interface Foo {
	[x: string]: unknown;
	[x: number]: unknown;
	foo: string;
	bar: symbol;
}

type Bar = {
	[x: number]: number;
	[x: symbol]: unknown;
	bar: Date;
	baz: boolean;
};

export type FooBar = Merge<Foo, Bar>;
// => {
// 	[x: string]: unknown;
// 	[x: number]: number;
// 	[x: symbol]: unknown;
// 	foo: string;
// 	bar: Date;
// 	baz: boolean;
// }
```

@category Object
*/
type Merge<Destination, Source> = Simplify<SimpleMerge<PickIndexSignature<Destination>, PickIndexSignature<Source>> & SimpleMerge<OmitIndexSignature<Destination>, OmitIndexSignature<Source>>>;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/internal/object.d.ts
/**
Merges user specified options with default options.

@example
```
type PathsOptions = {maxRecursionDepth?: number; leavesOnly?: boolean};
type DefaultPathsOptions = {maxRecursionDepth: 10; leavesOnly: false};
type SpecifiedOptions = {leavesOnly: true};

type Result = ApplyDefaultOptions<PathsOptions, DefaultPathsOptions, SpecifiedOptions>;
//=> {maxRecursionDepth: 10; leavesOnly: true}
```

@example
```
// Complains if default values are not provided for optional options

type PathsOptions = {maxRecursionDepth?: number; leavesOnly?: boolean};
type DefaultPathsOptions = {maxRecursionDepth: 10};
type SpecifiedOptions = {};

type Result = ApplyDefaultOptions<PathsOptions, DefaultPathsOptions, SpecifiedOptions>;
//                                              ~~~~~~~~~~~~~~~~~~~
// Property 'leavesOnly' is missing in type 'DefaultPathsOptions' but required in type '{ maxRecursionDepth: number; leavesOnly: boolean; }'.
```

@example
```
// Complains if an option's default type does not conform to the expected type

type PathsOptions = {maxRecursionDepth?: number; leavesOnly?: boolean};
type DefaultPathsOptions = {maxRecursionDepth: 10; leavesOnly: 'no'};
type SpecifiedOptions = {};

type Result = ApplyDefaultOptions<PathsOptions, DefaultPathsOptions, SpecifiedOptions>;
//                                              ~~~~~~~~~~~~~~~~~~~
// Types of property 'leavesOnly' are incompatible. Type 'string' is not assignable to type 'boolean'.
```

@example
```
// Complains if an option's specified type does not conform to the expected type

type PathsOptions = {maxRecursionDepth?: number; leavesOnly?: boolean};
type DefaultPathsOptions = {maxRecursionDepth: 10; leavesOnly: false};
type SpecifiedOptions = {leavesOnly: 'yes'};

type Result = ApplyDefaultOptions<PathsOptions, DefaultPathsOptions, SpecifiedOptions>;
//                                                                   ~~~~~~~~~~~~~~~~
// Types of property 'leavesOnly' are incompatible. Type 'string' is not assignable to type 'boolean'.
```
*/
type ApplyDefaultOptions<Options extends object, Defaults extends Simplify<Omit<Required<Options>, RequiredKeysOf<Options>> & Partial<Record<RequiredKeysOf<Options>, never>>>, SpecifiedOptions extends Options> = If<IsAny<SpecifiedOptions>, Defaults, If<IsNever<SpecifiedOptions>, Defaults, Simplify<Merge<Defaults, { [Key in keyof SpecifiedOptions as Key extends OptionalKeysOf<Options> ? undefined extends SpecifiedOptions[Key] ? never : Key : Key]: SpecifiedOptions[Key] }> & Required<Options>>>>;
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/except.d.ts
/**
Filter out keys from an object.

Returns `never` if `Exclude` is strictly equal to `Key`.
Returns `never` if `Key` extends `Exclude`.
Returns `Key` otherwise.

@example
```
type Filtered = Filter<'foo', 'foo'>;
//=> never
```

@example
```
type Filtered = Filter<'bar', string>;
//=> never
```

@example
```
type Filtered = Filter<'bar', 'foo'>;
//=> 'bar'
```

@see {Except}
*/
type Filter<KeyType$1, ExcludeType> = IsEqual<KeyType$1, ExcludeType> extends true ? never : (KeyType$1 extends ExcludeType ? never : KeyType$1);
type ExceptOptions = {
  /**
  Disallow assigning non-specified properties.
  	Note that any omitted properties in the resulting type will be present in autocomplete as `undefined`.
  	@default false
  */
  requireExactProps?: boolean;
};
type DefaultExceptOptions = {
  requireExactProps: false;
};

/**
Create a type from an object type without certain keys.

We recommend setting the `requireExactProps` option to `true`.

This type is a stricter version of [`Omit`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-5.html#the-omit-helper-type). The `Omit` type does not restrict the omitted keys to be keys present on the given type, while `Except` does. The benefits of a stricter type are avoiding typos and allowing the compiler to pick up on rename refactors automatically.

This type was proposed to the TypeScript team, which declined it, saying they prefer that libraries implement stricter versions of the built-in types ([microsoft/TypeScript#30825](https://github.com/microsoft/TypeScript/issues/30825#issuecomment-523668235)).

@example
```
import type {Except} from 'type-fest';

type Foo = {
	a: number;
	b: string;
};

type FooWithoutA = Except<Foo, 'a'>;
//=> {b: string}

const fooWithoutA: FooWithoutA = {a: 1, b: '2'};
//=> errors: 'a' does not exist in type '{ b: string; }'

type FooWithoutB = Except<Foo, 'b', {requireExactProps: true}>;
//=> {a: number} & Partial<Record<"b", never>>

const fooWithoutB: FooWithoutB = {a: 1, b: '2'};
//=> errors at 'b': Type 'string' is not assignable to type 'undefined'.

// The `Omit` utility type doesn't work when omitting specific keys from objects containing index signatures.

// Consider the following example:

type UserData = {
	[metadata: string]: string;
	email: string;
	name: string;
	role: 'admin' | 'user';
};

// `Omit` clearly doesn't behave as expected in this case:
type PostPayload = Omit<UserData, 'email'>;
//=> type PostPayload = { [x: string]: string; [x: number]: string; }

// In situations like this, `Except` works better.
// It simply removes the `email` key while preserving all the other keys.
type PostPayload = Except<UserData, 'email'>;
//=> type PostPayload = { [x: string]: string; name: string; role: 'admin' | 'user'; }
```

@category Object
*/
type Except<ObjectType, KeysType extends keyof ObjectType, Options extends ExceptOptions = {}> = _Except<ObjectType, KeysType, ApplyDefaultOptions<ExceptOptions, DefaultExceptOptions, Options>>;
type _Except<ObjectType, KeysType extends keyof ObjectType, Options extends Required<ExceptOptions>> = { [KeyType in keyof ObjectType as Filter<KeyType, KeysType>]: ObjectType[KeyType] } & (Options['requireExactProps'] extends true ? Partial<Record<KeysType, never>> : {});
//#endregion
//#region ../../node_modules/.pnpm/type-fest@5.2.0/node_modules/type-fest/source/require-at-least-one.d.ts
/**
Create a type that requires at least one of the given keys. The remaining keys are kept as is.

@example
```
import type {RequireAtLeastOne} from 'type-fest';

type Responder = {
	text?: () => string;
	json?: () => string;
	secure?: boolean;
};

const responder: RequireAtLeastOne<Responder, 'text' | 'json'> = {
	json: () => '{"message": "ok"}',
	secure: true
};
```

@category Object
*/
type RequireAtLeastOne<ObjectType, KeysType extends keyof ObjectType = keyof ObjectType> = IfNotAnyOrNever<ObjectType, If<IsNever<KeysType>, never, _RequireAtLeastOne<ObjectType, If<IsAny<KeysType>, keyof ObjectType, KeysType>>>>;
type _RequireAtLeastOne<ObjectType, KeysType extends keyof ObjectType> = {
  // For each `Key` in `KeysType` make a mapped type:
[Key in KeysType]-?: Required<Pick<ObjectType, Key>> &
// 1. Make `Key`'s type required
// 2. Make all other keys in `KeysType` optional
Partial<Pick<ObjectType, Exclude<KeysType, Key>>> }[KeysType] &
// 3. Add the remaining keys not in `KeysType`
Except<ObjectType, KeysType>;
//#endregion
//#region backend/agent/tool-schemas.d.ts
declare const ToolSpec: z$1.ZodDiscriminatedUnion<[z$1.ZodObject<{
  type: z$1.ZodLiteral<"openai_builtin">;
  openAITool: z$1.ZodDiscriminatedUnion<[z$1.ZodObject<{
    type: z$1.ZodLiteral<"file_search">;
    vector_store_ids: z$1.ZodArray<z$1.ZodString>;
    filters: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodAny>>;
    max_num_results: z$1.ZodOptional<z$1.ZodNumber>;
    ranking_options: z$1.ZodOptional<z$1.ZodAny>;
  }, z$1.core.$strip>, z$1.ZodObject<{
    type: z$1.ZodUnion<readonly [z$1.ZodLiteral<"web_search">, z$1.ZodLiteral<"web_search_2025_08_26">, z$1.ZodPipe<z$1.ZodPipe<z$1.ZodLiteral<"web_search_preview">, z$1.ZodTransform<string, "web_search_preview">>, z$1.ZodLiteral<"web_search">>, z$1.ZodPipe<z$1.ZodPipe<z$1.ZodLiteral<"web_search_preview_2025_03_11">, z$1.ZodTransform<string, "web_search_preview_2025_03_11">>, z$1.ZodLiteral<"web_search_2025_08_26">>]>;
    search_context_size: z$1.ZodOptional<z$1.ZodEnum<{
      low: "low";
      medium: "medium";
      high: "high";
    }>>;
    user_location: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodObject<{
      type: z$1.ZodLiteral<"approximate">;
      city: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodString>>;
      country: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodString>>;
      region: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodString>>;
      timezone: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodString>>;
    }, z$1.core.$strip>>>;
  }, z$1.core.$strip>, z$1.ZodObject<{
    type: z$1.ZodLiteral<"computer_use_preview">;
    display_height: z$1.ZodNumber;
    display_width: z$1.ZodNumber;
    environment: z$1.ZodEnum<{
      windows: "windows";
      mac: "mac";
      linux: "linux";
      ubuntu: "ubuntu";
      browser: "browser";
    }>;
  }, z$1.core.$strip>, z$1.ZodObject<{
    type: z$1.ZodLiteral<"mcp">;
    server_label: z$1.ZodString;
    server_url: z$1.ZodOptional<z$1.ZodString>;
    allowed_tools: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodUnion<readonly [z$1.ZodArray<z$1.ZodString>, z$1.ZodObject<{
      tool_names: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
    }, z$1.core.$strip>]>>>;
    headers: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodRecord<z$1.ZodString, z$1.ZodString>>>;
    require_approval: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodUnion<readonly [z$1.ZodLiteral<"always">, z$1.ZodLiteral<"never">, z$1.ZodObject<{
      always: z$1.ZodOptional<z$1.ZodObject<{
        tool_names: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
      }, z$1.core.$strip>>;
      never: z$1.ZodOptional<z$1.ZodObject<{
        tool_names: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
      }, z$1.core.$strip>>;
    }, z$1.core.$strip>]>>>;
  }, z$1.core.$strip>, z$1.ZodObject<{
    type: z$1.ZodLiteral<"code_interpreter">;
    container: z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodObject<{
      type: z$1.ZodLiteral<"auto">;
      file_ids: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
    }, z$1.core.$strip>]>;
  }, z$1.core.$strip>, z$1.ZodObject<{
    type: z$1.ZodLiteral<"image_generation">;
    background: z$1.ZodOptional<z$1.ZodEnum<{
      auto: "auto";
      transparent: "transparent";
      opaque: "opaque";
    }>>;
    input_image_mask: z$1.ZodOptional<z$1.ZodObject<{
      file_id: z$1.ZodOptional<z$1.ZodString>;
      image_url: z$1.ZodOptional<z$1.ZodString>;
    }, z$1.core.$strip>>;
    model: z$1.ZodOptional<z$1.ZodLiteral<"gpt-image-1">>;
    moderation: z$1.ZodOptional<z$1.ZodEnum<{
      low: "low";
      auto: "auto";
    }>>;
    output_compression: z$1.ZodOptional<z$1.ZodNumber>;
    output_format: z$1.ZodOptional<z$1.ZodEnum<{
      png: "png";
      webp: "webp";
      jpeg: "jpeg";
    }>>;
    partial_images: z$1.ZodOptional<z$1.ZodNumber>;
    quality: z$1.ZodOptional<z$1.ZodEnum<{
      low: "low";
      medium: "medium";
      high: "high";
      auto: "auto";
    }>>;
    size: z$1.ZodOptional<z$1.ZodEnum<{
      auto: "auto";
      "1024x1024": "1024x1024";
      "1024x1536": "1024x1536";
      "1536x1024": "1536x1024";
    }>>;
  }, z$1.core.$strip>, z$1.ZodObject<{
    type: z$1.ZodLiteral<"local_shell">;
  }, z$1.core.$strip>], "type">;
  triggerLLMRequest: z$1.ZodOptional<z$1.ZodDefault<z$1.ZodBoolean>>;
  hideOptionalInputs: z$1.ZodOptional<z$1.ZodDefault<z$1.ZodBoolean>>;
}, z$1.core.$strip>, z$1.ZodObject<{
  type: z$1.ZodLiteral<"agent_durable_object_tool">;
  methodName: z$1.ZodString;
  passThroughArgs: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodRecord<z$1.ZodString, z$1.ZodType<JSONSerializable, unknown, z$1.core.$ZodTypeInternals<JSONSerializable, unknown>>>>>;
  overrideName: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodString>>;
  overrideDescription: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodString>>;
  overrideInputJSONSchema: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodAny>>;
  strict: z$1.ZodOptional<z$1.ZodDefault<z$1.ZodBoolean>>;
  triggerLLMRequest: z$1.ZodOptional<z$1.ZodDefault<z$1.ZodBoolean>>;
  hideOptionalInputs: z$1.ZodOptional<z$1.ZodDefault<z$1.ZodBoolean>>;
  statusIndicatorText: z$1.ZodOptional<z$1.ZodNullable<z$1.ZodString>>;
}, z$1.core.$strip>], "type">;
type ToolSpec = z$1.infer<typeof ToolSpec>;
//#endregion
//#region backend/agent/context-schemas.d.ts
type ContextRuleMatcher = {
  type: "always";
} | {
  type: "never";
} | {
  type: "jsonata";
  expression: string;
} | {
  type: "and";
  matchers: ContextRuleMatcher[];
} | {
  type: "or";
  matchers: ContextRuleMatcher[];
} | {
  type: "not";
  matcher: ContextRuleMatcher;
} | {
  type: "timeWindow";
  windows: TimeWindow[];
  tz?: string;
};
declare const ContextRuleMatcher: z.ZodType<ContextRuleMatcher>;
declare const TimeWindow: z.ZodObject<{
  weekdays: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
    MO: "MO";
    TU: "TU";
    WE: "WE";
    TH: "TH";
    FR: "FR";
    SA: "SA";
    SU: "SU";
  }>, z.ZodNumber]>>>;
  months: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
    JAN: "JAN";
    FEB: "FEB";
    MAR: "MAR";
    APR: "APR";
    MAY: "MAY";
    JUN: "JUN";
    JUL: "JUL";
    AUG: "AUG";
    SEP: "SEP";
    OCT: "OCT";
    NOV: "NOV";
    DEC: "DEC";
  }>, z.ZodNumber]>>>;
  daysOfMonth: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
  timeOfDay: z.ZodOptional<z.ZodObject<{
    start: z.ZodString;
    end: z.ZodString;
  }, z.core.$strip>>;
  exact: z.ZodOptional<z.ZodObject<{
    month: z.ZodNumber;
    day: z.ZodNumber;
    hour: z.ZodNumber;
    minute: z.ZodNumber;
  }, z.core.$strip>>;
}, z.core.$strip>;
type TimeWindow = z.infer<typeof TimeWindow>;
declare const ToolPolicy: z.ZodObject<{
  approvalRequired: z.ZodOptional<z.ZodBoolean>;
  codemode: z.ZodOptional<z.ZodBoolean>;
  matcher: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type ToolPolicy = z.infer<typeof ToolPolicy>;
/**
 * Represents context (such as prompts and tool specs) to be provided to
 * an LLM via our AgentCore class
 */
type ContextItem = RequireAtLeastOne<{
  prompt: PromptFragment;
  tools: ToolSpec[];
  toolPolicies: ToolPolicy[];
}> & {
  key: string;
  description?: string;
};
declare const ContextItem: z.ZodObject<{
  key: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  prompt: z.ZodOptional<z.ZodType<PromptFragment, unknown, z.core.$ZodTypeInternals<PromptFragment, unknown>>>;
  tools: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"openai_builtin">;
    openAITool: z.ZodDiscriminatedUnion<[z.ZodObject<{
      type: z.ZodLiteral<"file_search">;
      vector_store_ids: z.ZodArray<z.ZodString>;
      filters: z.ZodOptional<z.ZodNullable<z.ZodAny>>;
      max_num_results: z.ZodOptional<z.ZodNumber>;
      ranking_options: z.ZodOptional<z.ZodAny>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodUnion<readonly [z.ZodLiteral<"web_search">, z.ZodLiteral<"web_search_2025_08_26">, z.ZodPipe<z.ZodPipe<z.ZodLiteral<"web_search_preview">, z.ZodTransform<string, "web_search_preview">>, z.ZodLiteral<"web_search">>, z.ZodPipe<z.ZodPipe<z.ZodLiteral<"web_search_preview_2025_03_11">, z.ZodTransform<string, "web_search_preview_2025_03_11">>, z.ZodLiteral<"web_search_2025_08_26">>]>;
      search_context_size: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
      }>>;
      user_location: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        type: z.ZodLiteral<"approximate">;
        city: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        country: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        region: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        timezone: z.ZodOptional<z.ZodNullable<z.ZodString>>;
      }, z.core.$strip>>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"computer_use_preview">;
      display_height: z.ZodNumber;
      display_width: z.ZodNumber;
      environment: z.ZodEnum<{
        windows: "windows";
        mac: "mac";
        linux: "linux";
        ubuntu: "ubuntu";
        browser: "browser";
      }>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"mcp">;
      server_label: z.ZodString;
      server_url: z.ZodOptional<z.ZodString>;
      allowed_tools: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
        tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>]>>>;
      headers: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodString>>>;
      require_approval: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"always">, z.ZodLiteral<"never">, z.ZodObject<{
        always: z.ZodOptional<z.ZodObject<{
          tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        never: z.ZodOptional<z.ZodObject<{
          tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
      }, z.core.$strip>]>>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"code_interpreter">;
      container: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        type: z.ZodLiteral<"auto">;
        file_ids: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>]>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"image_generation">;
      background: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        transparent: "transparent";
        opaque: "opaque";
      }>>;
      input_image_mask: z.ZodOptional<z.ZodObject<{
        file_id: z.ZodOptional<z.ZodString>;
        image_url: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>>;
      model: z.ZodOptional<z.ZodLiteral<"gpt-image-1">>;
      moderation: z.ZodOptional<z.ZodEnum<{
        low: "low";
        auto: "auto";
      }>>;
      output_compression: z.ZodOptional<z.ZodNumber>;
      output_format: z.ZodOptional<z.ZodEnum<{
        png: "png";
        webp: "webp";
        jpeg: "jpeg";
      }>>;
      partial_images: z.ZodOptional<z.ZodNumber>;
      quality: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        auto: "auto";
      }>>;
      size: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        "1024x1024": "1024x1024";
        "1024x1536": "1024x1536";
        "1536x1024": "1536x1024";
      }>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"local_shell">;
    }, z.core.$strip>], "type">;
    triggerLLMRequest: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    hideOptionalInputs: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"agent_durable_object_tool">;
    methodName: z.ZodString;
    passThroughArgs: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodType<JSONSerializable, unknown, z.core.$ZodTypeInternals<JSONSerializable, unknown>>>>>;
    overrideName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    overrideDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    overrideInputJSONSchema: z.ZodOptional<z.ZodNullable<z.ZodAny>>;
    strict: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    triggerLLMRequest: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    hideOptionalInputs: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    statusIndicatorText: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  }, z.core.$strip>], "type">>>;
  toolPolicies: z.ZodOptional<z.ZodArray<z.ZodObject<{
    approvalRequired: z.ZodOptional<z.ZodBoolean>;
    codemode: z.ZodOptional<z.ZodBoolean>;
    matcher: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>;
}, z.core.$strip>;
declare const ContextRule: z.ZodObject<{
  key: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  prompt: z.ZodOptional<z.ZodType<PromptFragment, unknown, z.core.$ZodTypeInternals<PromptFragment, unknown>>>;
  tools: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"openai_builtin">;
    openAITool: z.ZodDiscriminatedUnion<[z.ZodObject<{
      type: z.ZodLiteral<"file_search">;
      vector_store_ids: z.ZodArray<z.ZodString>;
      filters: z.ZodOptional<z.ZodNullable<z.ZodAny>>;
      max_num_results: z.ZodOptional<z.ZodNumber>;
      ranking_options: z.ZodOptional<z.ZodAny>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodUnion<readonly [z.ZodLiteral<"web_search">, z.ZodLiteral<"web_search_2025_08_26">, z.ZodPipe<z.ZodPipe<z.ZodLiteral<"web_search_preview">, z.ZodTransform<string, "web_search_preview">>, z.ZodLiteral<"web_search">>, z.ZodPipe<z.ZodPipe<z.ZodLiteral<"web_search_preview_2025_03_11">, z.ZodTransform<string, "web_search_preview_2025_03_11">>, z.ZodLiteral<"web_search_2025_08_26">>]>;
      search_context_size: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
      }>>;
      user_location: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        type: z.ZodLiteral<"approximate">;
        city: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        country: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        region: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        timezone: z.ZodOptional<z.ZodNullable<z.ZodString>>;
      }, z.core.$strip>>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"computer_use_preview">;
      display_height: z.ZodNumber;
      display_width: z.ZodNumber;
      environment: z.ZodEnum<{
        windows: "windows";
        mac: "mac";
        linux: "linux";
        ubuntu: "ubuntu";
        browser: "browser";
      }>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"mcp">;
      server_label: z.ZodString;
      server_url: z.ZodOptional<z.ZodString>;
      allowed_tools: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
        tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>]>>>;
      headers: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodString>>>;
      require_approval: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"always">, z.ZodLiteral<"never">, z.ZodObject<{
        always: z.ZodOptional<z.ZodObject<{
          tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        never: z.ZodOptional<z.ZodObject<{
          tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
      }, z.core.$strip>]>>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"code_interpreter">;
      container: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        type: z.ZodLiteral<"auto">;
        file_ids: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>]>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"image_generation">;
      background: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        transparent: "transparent";
        opaque: "opaque";
      }>>;
      input_image_mask: z.ZodOptional<z.ZodObject<{
        file_id: z.ZodOptional<z.ZodString>;
        image_url: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>>;
      model: z.ZodOptional<z.ZodLiteral<"gpt-image-1">>;
      moderation: z.ZodOptional<z.ZodEnum<{
        low: "low";
        auto: "auto";
      }>>;
      output_compression: z.ZodOptional<z.ZodNumber>;
      output_format: z.ZodOptional<z.ZodEnum<{
        png: "png";
        webp: "webp";
        jpeg: "jpeg";
      }>>;
      partial_images: z.ZodOptional<z.ZodNumber>;
      quality: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        auto: "auto";
      }>>;
      size: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        "1024x1024": "1024x1024";
        "1024x1536": "1024x1536";
        "1536x1024": "1536x1024";
      }>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"local_shell">;
    }, z.core.$strip>], "type">;
    triggerLLMRequest: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    hideOptionalInputs: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"agent_durable_object_tool">;
    methodName: z.ZodString;
    passThroughArgs: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodType<JSONSerializable, unknown, z.core.$ZodTypeInternals<JSONSerializable, unknown>>>>>;
    overrideName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    overrideDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    overrideInputJSONSchema: z.ZodOptional<z.ZodNullable<z.ZodAny>>;
    strict: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    triggerLLMRequest: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    hideOptionalInputs: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    statusIndicatorText: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  }, z.core.$strip>], "type">>>;
  toolPolicies: z.ZodOptional<z.ZodArray<z.ZodObject<{
    approvalRequired: z.ZodOptional<z.ZodBoolean>;
    codemode: z.ZodOptional<z.ZodBoolean>;
    matcher: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>;
  match: z.ZodOptional<z.ZodUnion<[z.ZodType<ContextRuleMatcher, unknown, z.core.$ZodTypeInternals<ContextRuleMatcher, unknown>>, z.ZodArray<z.ZodType<ContextRuleMatcher, unknown, z.core.$ZodTypeInternals<ContextRuleMatcher, unknown>>>]>>;
}, z.core.$strip>;
type ContextRule = z.infer<typeof ContextItem> & {
  match?: ContextRuleMatcher | ContextRuleMatcher[];
};
//#endregion
//#region backend/agent/context.d.ts
declare function always(): {
  type: "always";
};
declare function never(): {
  type: "never";
};
declare function jsonata(expression: string): {
  type: "jsonata";
  expression: string;
};
declare function hasParticipant(searchString: string): {
  type: "jsonata";
  expression: string;
};
declare function slackChannel(channelIdOrName: string): {
  type: "jsonata";
  expression: string;
};
declare function slackChannelHasExternalUsers(hasExternalUsers: boolean): {
  type: "jsonata";
  expression: string;
};
declare function and(...inner: ContextRuleMatcher[]): {
  type: "and";
  matchers: ContextRuleMatcher[];
};
declare function or(...inner: ContextRuleMatcher[]): {
  type: "or";
  matchers: ContextRuleMatcher[];
};
declare function not(inner: ContextRuleMatcher): {
  type: "not";
  matcher: ContextRuleMatcher;
};
declare function contextContains(searchString: string): {
  type: "jsonata";
  expression: string;
};
declare function hasTool(searchString: string): {
  type: "jsonata";
  expression: string;
};
declare function hasMCPConnection(searchString: string): {
  type: "jsonata";
  expression: string;
};
declare function forAgentClass(className: string): {
  type: "jsonata";
  expression: string;
};
declare function sandboxStatus(status: "starting" | "attached"): {
  type: "jsonata";
  expression: string;
};
declare function hasLabel(label: string): {
  type: "jsonata";
  expression: string;
};
declare const matchers: {
  never: typeof never;
  always: typeof always;
  jsonata: typeof jsonata;
  hasParticipant: typeof hasParticipant;
  slackChannel: typeof slackChannel;
  slackChannelHasExternalUsers: typeof slackChannelHasExternalUsers;
  contextContains: typeof contextContains;
  hasTool: typeof hasTool;
  hasMCPConnection: typeof hasMCPConnection;
  forAgentClass: typeof forAgentClass;
  sandboxStatus: typeof sandboxStatus;
  hasLabel: typeof hasLabel;
  and: typeof and;
  or: typeof or;
  not: typeof not;
  timeWindow: typeof timeWindow;
};
declare const defineRule: <Rule extends ContextRule>(rule: Rule) => Rule;
declare const defineRules: <Rules extends ContextRule[]>(rules: Rules) => Rules;
declare function timeWindow(windows: TimeWindow | TimeWindow[], opts?: {
  tz?: string;
}): {
  readonly type: "timeWindow";
  readonly windows: {
    weekdays?: (number | "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[] | undefined;
    months?: (number | "JAN" | "FEB" | "MAR" | "APR" | "MAY" | "JUN" | "JUL" | "AUG" | "SEP" | "OCT" | "NOV" | "DEC")[] | undefined;
    daysOfMonth?: number[] | undefined;
    timeOfDay?: {
      start: string;
      end: string;
    } | undefined;
    exact?: {
      month: number;
      day: number;
      hour: number;
      minute: number;
    } | undefined;
  }[];
  readonly tz: string | undefined;
};
/**
 * Parses front matter from a file content string.
 * Front matter is delimited by triple dashes (---) at the start of the file.
 * Returns the parsed front matter object and the remaining content.
 * The match field is automatically converted: strings become jsonata expressions,
 * objects are treated as ContextRuleMatcher directly.
 */

/**
 * Helper function to create context rules from files matching a glob pattern.
 * Each file becomes a context rule with slug derived from filename and prompt from file content.
 * Supports YAML front matter for overriding context rule properties.
 */
declare function contextRulesFromFiles(pattern: string, overrides?: Partial<ContextRule>): {
  key: string;
  description?: string | undefined;
  prompt: PromptFragment;
  tools?: ({
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  } | {
    type: "openai_builtin";
    openAITool: {
      type: "file_search";
      vector_store_ids: string[];
      filters?: any;
      max_num_results?: number | undefined;
      ranking_options?: any;
    } | {
      type: "web_search" | "web_search_2025_08_26";
      search_context_size?: "low" | "medium" | "high" | undefined;
      user_location?: {
        type: "approximate";
        city?: string | null | undefined;
        country?: string | null | undefined;
        region?: string | null | undefined;
        timezone?: string | null | undefined;
      } | null | undefined;
    } | {
      type: "computer_use_preview";
      display_height: number;
      display_width: number;
      environment: "windows" | "mac" | "linux" | "ubuntu" | "browser";
    } | {
      type: "mcp";
      server_label: string;
      server_url?: string | undefined;
      allowed_tools?: string[] | {
        tool_names?: string[] | undefined;
      } | null | undefined;
      headers?: Record<string, string> | null | undefined;
      require_approval?: "never" | "always" | {
        always?: {
          tool_names?: string[] | undefined;
        } | undefined;
        never?: {
          tool_names?: string[] | undefined;
        } | undefined;
      } | null | undefined;
    } | {
      type: "code_interpreter";
      container: string | {
        type: "auto";
        file_ids?: string[] | undefined;
      };
    } | {
      type: "image_generation";
      background?: "auto" | "transparent" | "opaque" | undefined;
      input_image_mask?: {
        file_id?: string | undefined;
        image_url?: string | undefined;
      } | undefined;
      model?: "gpt-image-1" | undefined;
      moderation?: "low" | "auto" | undefined;
      output_compression?: number | undefined;
      output_format?: "png" | "webp" | "jpeg" | undefined;
      partial_images?: number | undefined;
      quality?: "low" | "medium" | "high" | "auto" | undefined;
      size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024" | undefined;
    } | {
      type: "local_shell";
    };
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
  })[] | undefined;
  toolPolicies?: {
    approvalRequired?: boolean | undefined;
    codemode?: boolean | undefined;
    matcher?: string | undefined;
  }[] | undefined;
  match?: (ContextRuleMatcher | ContextRuleMatcher[]) | undefined;
}[];
//#endregion
//#region sdk/iterate-config.d.ts
type IterateConfig = {
  contextRules?: ContextRule[];
};
declare function defineConfig(config: IterateConfig): IterateConfig;
//#endregion
//#region sdk/index.d.ts
declare const tools: {
  sendSlackMessage: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      text: string;
      blocks?: Record<string, any>[] | undefined;
      ephemeral?: boolean | undefined;
      user?: string | undefined;
      metadata?: {
        event_type: string;
        event_payload: any;
      } | undefined;
      modalDefinitions?: Record<string, any> | undefined;
      unfurl?: "never" | "auto" | "all" | undefined;
      endTurn?: boolean | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  addSlackReaction: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      messageTs: string;
      name: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  removeSlackReaction: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      messageTs: string;
      name: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  updateSlackMessage: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      ts: string;
      text?: string | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  stopRespondingUntilMentioned: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      reason: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  uploadAndShareFileInSlack: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      iterateFileId: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  $infer: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<unknown> | undefined;
  }) | undefined) => ToolSpec;
  ping: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<unknown> | undefined;
  }) | undefined) => ToolSpec;
  shareFileWithSlack: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      iterateFileId: string;
      originalFilename?: string | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  flexibleTestTool: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      params: {
        behaviour: "slow-tool";
        recordStartTime: boolean;
        delay: number;
        response: string;
      } | {
        behaviour: "raise-error";
        error: string;
      } | {
        behaviour: "return-secret";
        secret: string;
      };
    }> | undefined;
  }) | undefined) => ToolSpec;
  reverse: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      message: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  doNothing: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      reason: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  getAgentDebugURL: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<Record<string, never>> | undefined;
  }) | undefined) => ToolSpec;
  remindMyselfLater: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      message: string;
      type: "numberOfSecondsFromNow" | "atSpecificDateAndTime" | "recurringCron";
      when: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  listMyReminders: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<Record<string, never>> | undefined;
  }) | undefined) => ToolSpec;
  cancelReminder: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      iterateReminderId: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  connectMCPServer: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      serverUrl: string;
      mode: "personal" | "company";
      requiresHeadersAuth: Record<string, {
        description: string;
        placeholder: string;
        sensitive: boolean;
      }> | null;
      requiresQueryParamsAuth: Record<string, {
        description: string;
        placeholder: string;
        sensitive: boolean;
      }> | null;
      onBehalfOfIterateUserId: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  getURLContent: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      url: string;
      includeScreenshotOfPage?: boolean | undefined;
      includeTextContent?: boolean | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  searchWeb: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      query: string;
      numResults: number;
    }> | undefined;
  }) | undefined) => ToolSpec;
  generateImage: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      prompt: string;
      inputImages: string[];
      model: `${string}/${string}` | `${string}/${string}:${string}`;
      quality: "low" | "medium" | "high";
      background: "auto" | "transparent" | "opaque";
      overrideReplicateParams?: Record<string, any> | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  exec: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      command: string;
      files?: {
        path: string;
        content: string;
      }[] | undefined;
      env?: Record<string, string> | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  execCodex: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      command: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  deepResearch: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      query: string;
      processor: "lite" | "base" | "core" | "core2x" | "pro" | "pro-fast" | "ultra" | "ultra-fast" | "ultra2x" | "ultra4x" | "ultra8x";
    }> | undefined;
  }) | undefined) => ToolSpec;
  uploadFile: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      path: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  generateVideo: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      prompt: string;
      model: "sora-2" | "sora-2-pro";
      seconds: "4" | "8" | "12";
      size: "720x1280" | "1280x720" | "1024x1792" | "1792x1024";
      inputReferenceFileId?: string | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  callGoogleAPI: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      endpoint: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      impersonateUserId: string;
      body?: any;
      queryParams?: Record<string, string> | undefined;
      pathParams?: Record<string, string> | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  sendGmail: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      to: string;
      subject: string;
      body: string;
      impersonateUserId: string;
      cc?: string | undefined;
      bcc?: string | undefined;
      threadId?: string | undefined;
      inReplyTo?: string | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  getGmailMessage: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      messageId: string;
      impersonateUserId: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  addLabel: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      label: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  messageAgent: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      agentName: string;
      message: string;
      triggerLLMRequest: boolean;
    }> | undefined;
  }) | undefined) => ToolSpec;
};
//#endregion
export { type ContextRule, type PromptFragment, type ToolSpec, contextRulesFromFiles, dedent, defineConfig, defineRule, defineRules, f, matchers, tools };