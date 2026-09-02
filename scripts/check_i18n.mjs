#!/usr/bin/env node
// Translation completeness gate (make check-i18n, CI).
// Fails when a key is missing in any language resource file, when a key used in the frontend
// sources is defined in no resource file, when a defined key is used nowhere, or when a dynamic
// key `t(`${...}`)` has no literal namespace prefix (that would mark every key as used).
// Scope: frontend/src/**/*.{ts,tsx} except *.test.* / *.spec.* files, src/test/ and *.d.ts.
// Known limitation: `t('key')` inside a comment counts as a use.
// No dependencies; Node 22+ (fs.globSync, import.meta.dirname).
import { globSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const i18nDir = path.join(root, 'frontend', 'src', 'i18n');
const srcDir = path.join(root, 'frontend', 'src');
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Flatten nested resource objects into dot-separated key paths. */
function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

const langFiles = readdirSync(i18nDir)
  .filter((f) => f.endsWith('.json'))
  .sort();
if (langFiles.length === 0) {
  console.error(`i18n: no resource files found in ${i18nDir}`);
  process.exit(1);
}

const keysByLang = new Map();
for (const file of langFiles) {
  const lang = path.basename(file, '.json');
  const data = JSON.parse(readFileSync(path.join(i18nDir, file), 'utf8'));
  const keys = new Set([...flatten(data).keys()].map((k) => k.replace(PLURAL_SUFFIX, '')));
  keysByLang.set(lang, keys);
}
const allKeys = new Set([...keysByLang.values()].flatMap((set) => [...set]));

const missing = [];
for (const [lang, keys] of keysByLang) {
  for (const key of allKeys) {
    if (!keys.has(key)) missing.push(`missing in ${lang}: ${key}`);
  }
}

// Usage scan: t('key'), t("key"), i18nKey="key" and template prefixes t(`prefix.${...}`).
const sourceFiles = globSync('**/*.{ts,tsx}', { cwd: srcDir }).filter(
  (f) => !/\.(test|spec)\.tsx?$/.test(f) && f.split(path.sep)[0] !== 'test' && !f.endsWith('.d.ts'),
);
const literalKeys = new Set();
const prefixes = new Set();
const dynamicWithoutPrefix = [];
const LITERAL_RE = /\bt\(\s*(['"])([^'"`]+?)\1/g;
const I18NKEY_RE = /\bi18nKey=(['"])([^'"]+?)\1/g;
const TEMPLATE_RE = /\bt\(\s*`([^`$]*)\$\{/g;
for (const file of sourceFiles) {
  const text = readFileSync(path.join(srcDir, file), 'utf8');
  for (const m of text.matchAll(LITERAL_RE)) literalKeys.add(m[2]);
  for (const m of text.matchAll(I18NKEY_RE)) literalKeys.add(m[2]);
  for (const m of text.matchAll(TEMPLATE_RE)) {
    if (m[1] === '') dynamicWithoutPrefix.push(`dynamic key without a literal prefix: ${file}`);
    else prefixes.add(m[1]);
  }
}

const isUsed = (key) => literalKeys.has(key) || [...prefixes].some((p) => key.startsWith(p));
const unused = [...allKeys].filter((key) => !isUsed(key)).sort();
const undefinedKeys = [...literalKeys]
  .filter((key) => !allKeys.has(key))
  .sort()
  .map((key) => `used but defined nowhere: ${key}`);

const findings = [
  ...missing,
  ...undefinedKeys,
  ...unused.map((key) => `unused: ${key}`),
  ...dynamicWithoutPrefix,
];
console.log(
  `i18n: ${keysByLang.size} languages, ${allKeys.size} keys, ${missing.length + undefinedKeys.length} missing, ${unused.length} unused, ${dynamicWithoutPrefix.length} dynamic without prefix`,
);
if (findings.length > 0) {
  for (const line of findings) console.error(`  ${line}`);
  process.exit(1);
}
