// @ts-check
'use strict';
// Post-call notes (docs/vkin-contracts.md): built only from memory the user APPROVED for that meeting, so the
// notes never contain anything the user has not seen and accepted. No model call; deterministic and free.

const SECTIONS = [
  ['decision', 'Decisions'],
  ['action_item', 'Action items'],
  ['commitment', 'My commitments'],
  ['open_question', 'Open questions'],
  ['topic', 'Topics'],
  ['fact', 'Facts noted'],
];
const WHO = { my_speech: 'I said', their_speech: 'they said', confirmed: 'confirmed', note: 'note' };
const MAX = 8000; // sessions.summary limit

/**
 * @param {{ startedAt?: string|null, items: { kind: string, text: string, origin: string, status: string, due_at?: string|null }[] }} p
 * @returns {string} plain-text notes, '' when nothing is approved
 */
function composeNotes({ startedAt = null, items }) {
  const approved = items.filter((i) => i.status === 'approved' && String(i.text || '').trim());
  if (!approved.length) return '';
  const lines = [`Meeting notes${startedAt ? ` (${new Date(startedAt).toLocaleDateString()})` : ''}`];
  for (const [kind, title] of SECTIONS) {
    const rows = approved.filter((i) => i.kind === kind);
    if (!rows.length) continue;
    lines.push('', `${title}:`);
    for (const i of rows) {
      const due = i.due_at ? `, due ${new Date(i.due_at).toLocaleDateString()}` : '';
      lines.push(`- ${String(i.text).trim()} (${WHO[/** @type {keyof typeof WHO} */ (i.origin)] || i.origin}${due})`);
    }
  }
  const text = lines.join('\n');
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

module.exports = { composeNotes };
