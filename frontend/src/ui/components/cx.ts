// Joins whole Tailwind class strings (brief l.550: every class name must appear as a complete
// literal in the source, so callers choose between complete strings and this only joins them).

export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}
