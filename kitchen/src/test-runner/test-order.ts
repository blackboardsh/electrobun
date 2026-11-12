export interface OrderableTest {
  category: string;
  interactive: boolean;
  automatedFirst?: boolean;
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
  return groupTestsByCategory(orderedTests);
}

function groupTestsByCategory<T extends OrderableTest>(tests: readonly T[]): TestGroup<T>[] {
  const groups = new Map<string, TestGroup<T>>();

  for (const test of tests) {
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

export function groupAutomatedTestsForRun<T extends OrderableTest>(tests: readonly T[]): TestGroup<T>[] {
  const automated = tests.filter((test) => !test.interactive);
  // Keep the early fixtures separate so their category's other tests retain
  // the original category order. Registration and display order stay intact.
  return [
    ...groupTestsByCategory(automated.filter((test) => test.automatedFirst)),
    ...groupTestsByCategory(automated.filter((test) => !test.automatedFirst)),
  ];
}
