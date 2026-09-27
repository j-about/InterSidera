#!/usr/bin/env node
// Translation completeness gate (make check-i18n, CI; plan D158 at M6).
// Fails (exit 1) when:
//   - a key is missing in any language resource file, a key used in the frontend sources is
//     defined in no resource file, a defined key is used nowhere, or a dynamic key t(`${...}`)
//     has no literal namespace prefix (that would mark every key as used);
//   - the set of `{{placeholder}}` names of a key differs between languages;
//   - a plural family (a base carrying a `_one`/`_other`/... suffix in any language) lacks `_one`
//     or `_other` in some language (extra CLDR categories such as the French `_many` are fine);
//   - a French value has a plain space (U+0020) right before `:`, `;`, `?`, `!` or `%`: French
//     typography puts a non-breaking space (U+00A0) there (a URL's `://` and a clock time such
//     as `12:30` carry no space before the colon, so they are outside the rule by construction);
//   - a value has leading or trailing whitespace, a double space, or "..." instead of "…".
// Warns (exit 0) when a value is identical in every language outside the allow-list below (a
// forgotten translation looks exactly like that), and when a placeholder is followed by a plain
// space and a unit word (`{{count}} min`): U+00A0 keeps the number and its unit on one line.
// Scope: frontend/src/**/*.{ts,tsx} except *.test.* / *.spec.* files, src/test/ and *.d.ts.
// Known limitation: `t('key')` inside a comment counts as a use.
// No dependencies; Node 22+ (fs.globSync, import.meta.dirname).
import { globSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const i18nDir = path.join(root, 'frontend', 'src', 'i18n');
const srcDir = path.join(root, 'frontend', 'src');
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
/** The two forms every language must carry for a plural base (i18next resolves the rest). */
const REQUIRED_PLURAL_FORMS = ['one', 'other'];
/** `{{name}}`, `{{name, format}}`: the name alone identifies the placeholder. */
const PLACEHOLDER_RE = /\{\{\s*([^,}\s]+)/g;
/** The file whose values follow French typography. */
const FRENCH_LANG = 'fr';
/** A plain space before a mark that takes a non-breaking one in French (the first hit is reported). */
const FRENCH_MARK_RE = / ([:;?!%])/;
/** A placeholder, a plain space and a unit word: `{{seconds}} s`, `{{count}} min`. */
const UNIT_AFTER_PLACEHOLDER_RE = /\{\{[^}]*\}\} (?:s|min|h|m|km)\b/;
/**
 * Values legitimately identical in every language (proper nouns, symbols, shared words): no
 * warning for these. Anything else identical is reported as a probable missing translation.
 */
const IDENTICAL_ALLOWED = [
  // Names of constellations, bodies and preset sites, cardinal letters, unit symbols.
  /^constellations\./,
  /^bodies\./,
  /^presets\./,
  /^units\./,
  /^cardinal\./,
  // Endonyms of the language toggle.
  /^lang\./,
  // Catalogue designations and shared French/English words of the details panel.
  /^details\.(hip|messier|constellation|distance|magnitude|type)$/,
  // Headings that read the same in both languages.
  /^about\.(attribution|catalogConstellations|notes|source)$/,
  /^app\.title$/,
  /^a11y\.notifications$/,
  /^kinds\.constellation$/,
  /^layers\.groundOpaque$/,
  /^observer\.(latitude|longitude)$/,
  // Time vocabulary shared by both languages (`Pause`, `UTC`, `UT`, `minute`) and unit strings.
  /^time\.(minute|pause|ut|utc)$/,
  /^time\.step\.minute$/,
  /^time\.speedUnit\./,
  /^ar\.offset\.(hours|minutes)_/,
  /^ar\.compass\.accuracy$/,
];

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

/** lang -> Map(leaf key -> string value), plural suffixes kept. */
const leavesByLang = new Map();
/** lang -> Set(key with the plural suffix folded). */
const keysByLang = new Map();
for (const file of langFiles) {
  const lang = path.basename(file, '.json');
  const data = JSON.parse(readFileSync(path.join(i18nDir, file), 'utf8'));
  const leaves = flatten(data);
  leavesByLang.set(lang, leaves);
  keysByLang.set(lang, new Set([...leaves.keys()].map((k) => k.replace(PLURAL_SUFFIX, ''))));
}
const langs = [...leavesByLang.keys()];
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

// Placeholder parity: the `{{name}}` set of a leaf must be the same in every language that has
// it; a plural form one language lacks is compared with that language's `_other` form.
const placeholderNames = (value) =>
  typeof value === 'string' ? [...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1]).sort() : [];
const allLeaves = new Set([...leavesByLang.values()].flatMap((leaves) => [...leaves.keys()]));
const placeholderMismatch = [];
for (const leaf of [...allLeaves].sort()) {
  const perLang = [];
  for (const lang of langs) {
    const leaves = leavesByLang.get(lang);
    const fallback = leaf.replace(PLURAL_SUFFIX, '_other');
    const value = leaves.has(leaf) ? leaves.get(leaf) : leaves.get(fallback);
    if (value !== undefined) perLang.push([lang, placeholderNames(value)]);
  }
  const reference = perLang[0]?.[1].join(',');
  if (perLang.some(([, names]) => names.join(',') !== reference)) {
    const detail = perLang.map(([lang, names]) => `${lang} {${names.join(',')}}`).join(' ');
    placeholderMismatch.push(`placeholder mismatch: ${leaf}: ${detail}`);
  }
}

// Plural families: a base with a suffix anywhere needs `_one` and `_other` in every language.
const pluralBases = new Set();
for (const leaves of leavesByLang.values()) {
  for (const leaf of leaves.keys()) {
    if (PLURAL_SUFFIX.test(leaf)) pluralBases.add(leaf.replace(PLURAL_SUFFIX, ''));
  }
}
const pluralIncomplete = [];
for (const base of [...pluralBases].sort()) {
  for (const lang of langs) {
    const leaves = leavesByLang.get(lang);
    const absent = REQUIRED_PLURAL_FORMS.filter((form) => !leaves.has(`${base}_${form}`));
    if (absent.length > 0) {
      pluralIncomplete.push(
        `plural family incomplete in ${lang}: ${base} lacks ${absent.map((f) => `_${f}`).join(', ')}`,
      );
    }
  }
}

// Typography: French spacing before punctuation, and whitespace hygiene in every language.
const typography = [];
const frenchLeaves = leavesByLang.get(FRENCH_LANG) ?? new Map();
for (const [leaf, value] of frenchLeaves) {
  if (typeof value !== 'string') continue;
  const m = FRENCH_MARK_RE.exec(value);
  if (m !== null) {
    typography.push(
      `fr typography: ${leaf}: a non-breaking space (U+00A0) goes before "${m[1]}": ${JSON.stringify(value)}`,
    );
  }
}
for (const [lang, leaves] of leavesByLang) {
  for (const [leaf, value] of leaves) {
    if (typeof value !== 'string') continue;
    if (value !== value.trim()) typography.push(`${lang} whitespace: ${leaf}: leading or trailing`);
    if (value.includes('  ')) typography.push(`${lang} whitespace: ${leaf}: double space`);
    if (value.includes('...')) typography.push(`${lang} typography: ${leaf}: "..." for "…"`);
  }
}

// Warnings: identical values outside the allow-list, plain spaces before unit words.
const warnings = [];
let identicalCount = 0;
let unitCount = 0;
if (langs.length > 1) {
  const first = leavesByLang.get(langs[0]);
  for (const [leaf, value] of first) {
    if (typeof value !== 'string' || value === '') continue;
    const everywhere = langs.every((lang) => leavesByLang.get(lang).get(leaf) === value);
    const base = leaf.replace(PLURAL_SUFFIX, '');
    if (everywhere && !IDENTICAL_ALLOWED.some((re) => re.test(leaf) || re.test(base))) {
      identicalCount += 1;
      warnings.push(`identical in every language: ${leaf} = ${JSON.stringify(value)}`);
    }
  }
}
for (const [lang, leaves] of leavesByLang) {
  for (const [leaf, value] of leaves) {
    if (typeof value === 'string' && UNIT_AFTER_PLACEHOLDER_RE.test(value)) {
      unitCount += 1;
      warnings.push(
        `${lang} unit spacing: ${leaf}: a non-breaking space (U+00A0) keeps the unit with its number: ${JSON.stringify(value)}`,
      );
    }
  }
}

const findings = [
  ...missing,
  ...undefinedKeys,
  ...unused.map((key) => `unused: ${key}`),
  ...dynamicWithoutPrefix,
  ...placeholderMismatch,
  ...pluralIncomplete,
  ...typography,
];
console.log(
  `i18n: ${keysByLang.size} languages, ${allKeys.size} keys, ${missing.length + undefinedKeys.length} missing, ${unused.length} unused, ${dynamicWithoutPrefix.length} dynamic without prefix, ${placeholderMismatch.length} placeholder, ${pluralIncomplete.length} plural, ${typography.length} typography`,
);
if (warnings.length > 0) {
  console.log(`i18n warnings: ${identicalCount} identical, ${unitCount} unit spacing`);
  for (const line of warnings) console.log(`  warning: ${line}`);
}
if (findings.length > 0) {
  for (const line of findings) console.error(`  ${line}`);
  process.exit(1);
}
