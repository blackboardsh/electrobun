import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";

const interactiveTestsDirectory = new URL("../tests/interactive/", import.meta.url);
const interactiveTestFiles = readdirSync(interactiveTestsDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .sort();

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  return property.name && ts.isIdentifier(property.name)
    ? property.name.text
    : property.name && ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
}

function instructionsAreNonEmpty(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return instructionsAreNonEmpty(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      instructionsAreNonEmpty(expression.whenTrue) &&
      instructionsAreNonEmpty(expression.whenFalse)
    );
  }
  return ts.isArrayLiteralExpression(expression) && expression.elements.length > 0;
}

describe("interactive test UX contract", () => {
  it("gives every interactive TypeScript test non-empty static instructions", () => {
    let interactiveDefinitions = 0;

    for (const fileName of interactiveTestFiles) {
      const sourceText = readFileSync(new URL(fileName, interactiveTestsDirectory), "utf8");
      const sourceFile = ts.createSourceFile(
        fileName,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      const visit = (node: ts.Node): void => {
        const [firstArgument] = ts.isCallExpression(node) ? node.arguments : [];
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "defineTest" &&
          firstArgument &&
          ts.isObjectLiteralExpression(firstArgument)
        ) {
          const config = firstArgument;
          const interactive = config.properties.find(
            (property) => propertyName(property) === "interactive",
          );
          if (
            interactive &&
            ts.isPropertyAssignment(interactive) &&
            interactive.initializer.kind === ts.SyntaxKind.TrueKeyword
          ) {
            interactiveDefinitions += 1;
            const instructions = config.properties.find(
              (property) => propertyName(property) === "instructions",
            );
            assert.ok(
              instructions &&
                ts.isPropertyAssignment(instructions) &&
                instructionsAreNonEmpty(instructions.initializer),
              `${fileName} has an interactive test without non-empty static instructions`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    assert.ok(interactiveDefinitions > 0, "expected interactive test definitions");
  });

  it("does not use the removed readiness or verification context APIs", () => {
    const removedApis = [
      "showInstructions",
      "waitForUserVerification",
      "waitForUserAction",
    ];

    for (const fileName of interactiveTestFiles) {
      const sourceText = readFileSync(new URL(fileName, interactiveTestsDirectory), "utf8");
      for (const removedApi of removedApis) {
        assert.equal(
          sourceText.includes(removedApi),
          false,
          `${fileName} still uses ${removedApi}`,
        );
      }
    }

    const frameworkSources = [
      new URL("../test-framework/types.ts", import.meta.url),
      new URL("../test-framework/executor.ts", import.meta.url),
      new URL("../bun/index.ts", import.meta.url),
      new URL("./index.ts", import.meta.url),
      new URL("./rpc.ts", import.meta.url),
    ];
    for (const sourceUrl of frameworkSources) {
      const sourceText = readFileSync(sourceUrl, "utf8");
      for (const removedApi of removedApis) {
        assert.equal(
          sourceText.includes(removedApi),
          false,
          `${sourceUrl.pathname} still uses ${removedApi}`,
        );
      }
    }

    const runnerHtml = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    for (const removedControl of [
      "interactive-modal",
      "btn-start",
      "btn-pass",
      "btn-fail",
      "btn-retest",
      "notes-input",
    ]) {
      assert.equal(
        runnerHtml.includes(removedControl),
        false,
        `test runner HTML still contains ${removedControl}`,
      );
    }
  });
});
