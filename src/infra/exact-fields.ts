/** Return true only when an object has exactly the expected own enumerable keys. */
export const hasExactFields = (value: object, fields: readonly string[]): boolean => {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return (
		actual.length === expected.length && actual.every((field, index) => field === expected[index])
	);
};
