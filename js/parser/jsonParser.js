// Unwrap the JSON wrapper returned by Doris FE GET /api/profile.
// Shape: { msg: "success", code: 0, data: { profile: "<text>" } }
// Doris 3.x doc: https://doris.apache.org/docs/3.x/admin-manual/open-api/fe-http/query-profile-action/

export function unwrapJson(input) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    return { ok: false, reason: 'Invalid JSON: ' + e.message };
  }
  const text = parsed && parsed.data && parsed.data.profile;
  if (typeof text !== 'string') {
    return { ok: false, reason: 'JSON wrapper missing data.profile string' };
  }
  return { ok: true, text };
}
