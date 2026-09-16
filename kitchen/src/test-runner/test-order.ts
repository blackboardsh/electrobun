export interface OrderableTest {
  category: string;
  interactive: boolean;
}

export interface TestGroup<T> {
  category: string;
  interactive: boolean;
  tests: T[];
}

export function groupTestsForDisplay<T extends OrderableTest>(
  tests: readonly T[],
): TestGroup<T>[] {
  const orderedTests = [...tests].sort(
    (a, b) => Number(b.interactive) - Number(a.interactive),
  );
  const groups = new Map<string, TestGroup<T>>();

  for (const test of orderedTests) {
    const groupKey = `${test.interactive ? 'interactive' : 'automated'}:${test.category}`;
    const group = groups.get(groupKey) || {
      category: test.category,
      interactive: test.interactive,
      tests: [],
    };
    group.tests.push(test);
    groups.set(groupKey, group);
  }

  return [...groups.values()];
}
