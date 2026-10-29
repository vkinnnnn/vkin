'use strict';
// Phase 3 prep window: local parsing, chunking with provenance, and the session store. Runs on temp
// folders; no network, no model calls.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { parseDocument, readZipEntry, htmlToText, jsonToText } = require('../src/main/prep/doc-parse');
const { chunkText, toPackRecords, scrub, extractEntities } = require('../src/main/prep/chunk');
const { createPrepStore } = require('../src/main/prep/prep-store');
const { loadMeetingPack } = require('../src/main/meeting');
const { validateRecord } = require('../src/main/brain/schema');

/** Minimal zip writer (deflate) for building .docx fixtures. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const DOCX_XML = '<w:document><w:body>'
  + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Research Interests</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t xml:space="preserve">Professor Example studies social capital </w:t></w:r><w:r><w:t>&amp; disaster recovery.</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>Contact: prof@example.edu or 617-555-0101.</w:t></w:r></w:p>'
  + '</w:body></w:document>';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fabel-prep-'));
}

test('docx: zip reader + paragraph/heading extraction + entity decoding', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'profile.docx');
  fs.writeFileSync(f, makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': DOCX_XML }));
  const r = await parseDocument(f);
  assert.equal(r.format, 'docx');
  assert.match(r.text, /^# Research Interests/m);
  assert.match(r.text, /social capital & disaster recovery\./);
  assert.equal(readZipEntry(fs.readFileSync(f), 'missing.xml'), null);
});

test('html, json and markdown are reduced to readable text; scripts dropped', async () => {
  assert.equal(htmlToText('<h2>About</h2><p>Hi &amp; welcome</p><script>alert(1)</script>'), '## About\nHi & welcome');
  assert.match(jsonToText('{"name":"Ada","url":"https://x","bio":"Builds compilers","tags":["ml","nlp"]}'), /name: Ada\nbio: Builds compilers\ntags: ml\ntags: nlp/);
  const dir = tmpdir();
  const f = path.join(dir, 'notes.md');
  fs.writeFileSync(f, '\uFEFF# Agenda\r\n\r\nDiscuss the paper.\r\n');
  const r = await parseDocument(f);
  assert.equal(r.text, '# Agenda\n\nDiscuss the paper.');
});

test('unsupported types and oversized files are refused before reading', async () => {
  await assert.rejects(parseDocument('x.exe'), /unsupported file type/);
  await assert.rejects(parseDocument('big.txt', { stat: async () => ({ size: 26 * 1024 * 1024 }), readFile: async () => Buffer.alloc(0) }), /larger than/);
});

test('pdf: real PDF text extraction through pdfjs (local, no network)', async () => {
  // A tiny hand-built PDF with one text line.
  const content = 'BT /F1 18 Tf 72 720 Td (Hello FABEL prep window) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const dir = tmpdir();
  const f = path.join(dir, 'paper.pdf');
  fs.writeFileSync(f, pdf, 'latin1');
  const r = await parseDocument(f);
  assert.equal(r.pages, 1);
  assert.match(r.text, /Hello FABEL prep window/);
});

test('chunking keeps headings and spans; contact data and URLs are scrubbed; records are schema-valid', () => {
  const text = '# Research Interests\n\nProfessor Example studies Social Capital and Disaster Recovery in Japan. Social Capital matters.\n\nWrite to prof@example.edu, call 617-555-0101 or see https://example.edu/page.\n\n## Teaching\n\nTeaches GIS methods.';
  const chunks = chunkText(text, { maxChars: 200 });
  assert.equal(chunks[0].heading, 'Research Interests');
  assert.equal(chunks[chunks.length - 1].heading, 'Teaching');
  assert.equal(scrub('mail a@b.co or 617-555-0101 https://x.y/z'), 'mail [email] or [phone]');
  const recs = toPackRecords(text, { docId: 'profile', docName: 'profile.md', kind: 'supplementary', side: 'them' });
  assert.ok(recs.length >= 2);
  assert.match(recs[0].id, /^DOC-profile-001$/);
  assert.match(recs[0].span, /^L\d+-L\d+$/);
  for (const r of recs) {
    assert.doesNotMatch(r.text, /@example|617-555|https?:/);
    const rec = { id: r.id, type: 'fact', title: r.title, text: r.text, source_path: 'x', source_span: r.span, effective_from: null, effective_to: null, updated_at: '2026-10-17', confidence: 0.75, sensitivity: 'public', entities: r.entities, tags: r.tags, approved: true, evidence: 'research' };
    assert.deepEqual(validateRecord(rec), []);
  }
  assert.ok(extractEntities('We met Social Capital people. Social Capital again. GIS and GIS.').includes('GIS'));
});

function storeFixture() {
  const root = tmpdir();
  const config = { meeting: { enabled: false, profile: '', dir: 'meeting-packs' } };
  let written = null;
  const store = createPrepStore({ root, config, now: () => Date.parse('2026-10-17T12:00:00Z') });
  return { root, config, store, writeConfig: (c) => { written = JSON.parse(JSON.stringify(c)); }, written: () => written };
}

test('store: create from a template, edit, import a document, validate, activate', async () => {
  const { root, config, store, writeConfig, written } = storeFixture();
  const s = store.createSession({ templateId: 'research-meeting', title: 'Paper chat', person: 'Professor Example', organization: 'State University', date: '2026-10-20' });
  assert.equal(s.id, '2026-10-20-professor-example');
  assert.equal(s.session.mode, 'manual');
  assert.equal(s.preferences.technicalDepth, 'deep');
  assert.equal(s.expires, '2026-10-27');

  const u = store.updateSession(s.id, { summary: 'Who: Professor Example\nPurpose: discuss a paper', keyterms: ['OKR', 'OKR', 'bridging'], preferences: { length: 'medium', evil: 1 }, restricted: [{ phrase: 'co-authored', reason: 'I did not co-author anything' }] });
  assert.deepEqual(u.keyterms, ['OKR', 'bridging']);
  assert.equal(u.preferences.length, 'medium');
  assert.equal(u.preferences.evil, undefined);
  assert.equal(u.restricted[0].phrase, 'co-authored');

  const docPath = path.join(root, 'agenda.md');
  fs.writeFileSync(docPath, '# Agenda\n\nWe will discuss the overlap between social capital measures and the OKR index.\n\n# Logistics\n\nMeeting on Zoom for 30 minutes on Tuesday.');
  const imp = await store.importDocument(s.id, { filePath: docPath, side: 'them', kind: 'logistics' });
  assert.equal(imp.document.status, 'indexed');
  assert.ok(imp.document.records >= 2);
  await assert.rejects(store.importDocument(s.id, { filePath: docPath, side: 'them', kind: 'logistics' }), /already imported/);

  const v = store.validate(s.id);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.ok(v.stats.records >= 2);

  // The real loader reads what the store wrote, including preferences and the restricted phrase.
  const pack = loadMeetingPack({ settings: { enabled: true, profile: s.id, dir: path.join(root, 'meeting-packs') }, root, today: '2026-10-21' });
  assert.ok(pack.records.some((r) => r.fields.kind === 'logistics' && /Zoom/.test(r.text)));
  assert.equal(pack.preferences.length, 'medium');
  assert.ok(pack.forbidden.some((f) => f.re.test('I co-authored the index')));
  assert.ok(!pack.forbidden.some((f) => f.re.test('I co-authoredx')));

  const a = store.activate(s.id, writeConfig);
  assert.equal(a.restartRequired, true);
  assert.equal(written().meeting.profile, s.id);
  assert.equal(written().meeting.enabled, true);
  assert.equal(store.listSessions()[0].active, true);
  assert.equal(config.meeting.profile, s.id);
});

test('store: About Me documents are unverified until confirmed; typed notes; removal', async () => {
  const { root, store } = storeFixture();
  const s = store.createSession({ title: 'Screen', person: 'Recruiter', date: '2026-10-20' });
  const resume = path.join(root, 'resume.txt');
  fs.writeFileSync(resume, 'Built a forecasting pipeline in Python on Azure with weekly retraining for a retail client in 2023.');
  const imp = await store.importDocument(s.id, { filePath: resume, side: 'me', kind: 'personal' });
  assert.equal(imp.document.approved, false);
  assert.ok(store.validate(s.id).warnings.some((w) => /not verified/.test(w)));
  const pack1 = loadMeetingPack({ settings: { enabled: true, profile: s.id, dir: path.join(root, 'meeting-packs') }, root, today: '2026-10-20' });
  assert.ok(pack1.records.every((r) => r.approved === false), 'unverified About Me records are not evidence');
  store.setDocumentApproved(s.id, imp.document.id, true);
  const pack2 = loadMeetingPack({ settings: { enabled: true, profile: s.id, dir: path.join(root, 'meeting-packs') }, root, today: '2026-10-20' });
  assert.ok(pack2.records.every((r) => r.approved === true));

  const t = store.addTypedRecord(s.id, { side: 'them', kind: 'logistics', title: 'Start date', text: 'They want someone to start in January, 20 hours a week.' });
  assert.equal(t.typed.length, 1);
  assert.equal(t.typed[0].id, 'NOTE-001');
  assert.equal(store.removeTypedRecord(s.id, 'NOTE-001').typed.length, 0);
  const r = store.removeDocument(s.id, imp.document.id);
  assert.equal(r.documents.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'meeting-packs', s.id, imp.document.file)), false);
});

test('store: path traversal and bad kinds are rejected; expired packs fail validation', async () => {
  const { store } = storeFixture();
  assert.throws(() => store.getSession('../etc'), /invalid session id/);
  assert.throws(() => store.getSession('_templates'), /invalid session id/);
  const s = store.createSession({ title: 'Old', person: 'Someone', date: '2026-01-01' });
  await assert.rejects(store.importDocument(s.id, { filePath: 'x.txt', side: 'them', kind: 'personal' }), /kind for them/);
  assert.throws(() => store.removeDocument(s.id, '../../x'), /invalid document id/);
  const v = store.validate(s.id);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /expired on 2026-01-08/);
  assert.throws(() => store.activate(s.id, () => {}), /fix these first/);
});

test('store: budget estimate scales with meeting length', () => {
  const { store } = storeFixture();
  const s = store.createSession({ title: 'Long', person: 'P', date: '2026-10-20', durationMin: 60 });
  const e = store.estimateBudget(s.id);
  assert.equal(e.expectedAnswers, 30);
  assert.ok(e.estimatedUsd > 0.2 && e.estimatedUsd < 0.3);
});
