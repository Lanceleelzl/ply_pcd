import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = dirname(fileURLToPath(import.meta.url));
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.ts$/.test(path) && !/\.test\.ts$/.test(path) ? [path] : [];
  });
}

for (const layer of ['engine', 'shared']) {
  test(`${layer} has no dependency on higher application layers`, () => {
    const violations: string[] = [];
    for (const path of files(join(root, layer))) {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const check = (specifier: string) => {
        const target = specifier.startsWith('.')
          ? relative(root, resolve(dirname(path), specifier)).replaceAll('\\', '/') : specifier;
        const forbidden = layer === 'shared' ? !target.startsWith('shared/')
          : /^(app|views|pages|stores)\//.test(target) || /^(vue|pinia|vue-router)(\/|$)/.test(target) || target.endsWith('.vue');
        if (forbidden) violations.push(`${relative(root, path)} -> ${specifier}`);
      };
      const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
          if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    assert.deepEqual(violations, []);
  });
}
