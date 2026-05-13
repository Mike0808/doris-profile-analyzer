// Detect the input format. The Doris FE returns either a JSON wrapper
// (api/profile) or plain profile text (api/profile_text / SHOW QUERY PROFILE).
// Detection rule: first non-whitespace, non-BOM character.

export function detect(input) {
  if (typeof input !== 'string') return 'text';
  let i = 0;
  // Skip BOM.
  if (input.charCodeAt(0) === 0xFEFF) i = 1;
  // Skip whitespace.
  while (i < input.length && /\s/.test(input[i])) i++;
  return input[i] === '{' ? 'json' : 'text';
}
