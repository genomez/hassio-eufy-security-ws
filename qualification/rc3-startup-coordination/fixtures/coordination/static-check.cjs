'use strict';
// Syntax and declarative case-count inspection only; product and test modules are never executed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(process.env.FIXTURE_TOOLCHAIN_ROOT || '/usr/src/app/client/node_modules', 'typescript'));
const results = [];
let total = 0;
for (const file of fs.readdirSync(__dirname).filter(name => /\.(cjs|ts)$/.test(name))) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  if (file.endsWith('.cjs')) { new vm.Script(source, { filename: file }); results.push({ file, syntax: 'ok' }); continue; }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (tree.parseDiagnostics.length) throw new Error(`Fixture syntax failure: ${file}`);
  let cases = 0;
  function count(node, multiplier = 1) {
    if (ts.isCallExpression(node)) {
      let kind, rows = 1;
      if (ts.isIdentifier(node.expression)) kind = node.expression.text;
      if (ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression)
        && node.expression.expression.name.text === 'each') {
        kind = node.expression.expression.expression.getText(tree);
        const data = node.expression.arguments[0];
        if (!ts.isArrayLiteralExpression(data)) throw Error(`Nonliteral fixture matrix: ${file}`);
        rows = data.elements.length;
      }
      if (kind === 'test' || kind === 'it') { cases += rows * multiplier; return; }
      if (kind === 'describe') {
        const callback = node.arguments.find(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
        if (callback) { count(callback.body, multiplier * rows); return; }
      }
    }
    ts.forEachChild(node, child => count(child, multiplier));
  }
  count(tree); total += cases; results.push({ file, syntax: 'ok', cases });
}
process.stdout.write(JSON.stringify({ syntax: 'ok', testsExecuted: false, productExecuted: false, totalCases: total, files: results }, null, 2) + '\n');
