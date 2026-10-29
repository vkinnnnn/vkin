// Personal-memory controls (local only, no network).
//   node scripts/memory.js list                      current corrections (overrides + yours)
//   node scripts/memory.js history <target>          all versions for a target (e.g. EXP-001)
//   node scripts/memory.js add <target> "<text>" [--replaces <id>]   add a fact, or a new version of <id>
//   node scripts/memory.js remove <id>               tombstone a correction you added
//   node scripts/memory.js export [file]             export every correction line as JSON
//   node scripts/memory.js purge --confirm           delete your corrections file
const fs = require('fs');
const path = require('path');
const { createCorrections, compileAliases } = require('../src/main/brain/corrections');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const corrections = createCorrections({
  dataDir: resolve(path.join(path.dirname(config.budget.dataDir), 'brain')),
  overridesPath: resolve(config.profile.overrides),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  aliases: compileAliases(config.profile.correctionAliases),
});
const [cmd, a, b] = process.argv.slice(2);
const show = (rows) => rows.forEach((c) => console.log(`${c.id}  v${c.version}  -> ${c.supersedes}\n    ${c.text}`));

switch (cmd) {
  case 'list': show(corrections.list()); break;
  case 'history': show(corrections.history(a)); break;
  case 'add': {
    const ri = process.argv.indexOf('--replaces');
    const existing = corrections.list().filter((c) => c.supersedes === a);
    if (ri === -1 && existing.length && !process.argv.includes('--new')) {
      console.log(`"${a}" already has correction(s): ${existing.map((c) => c.id).join(', ')}.`);
      console.log('Use --replaces <id> to supersede one, or --new to add a separate fact alongside them.');
      break;
    }
    show([corrections.add({ supersedes: a, text: b, ...(ri !== -1 ? { replaces: process.argv[ri + 1] } : {}) })]);
    console.log('Restart the app to use it.');
    break;
  }
  case 'remove': corrections.remove(a); console.log(`Removed ${a} (tombstoned; history kept).`); break;
  case 'export': {
    const out = corrections.exportAll();
    if (a) { fs.writeFileSync(a, out); console.log(`Exported to ${a}`); } else console.log(out);
    break;
  }
  case 'purge': {
    if (!process.argv.includes('--confirm')) { console.log('Refused: pass --confirm to delete your corrections file.'); break; }
    console.log(corrections.purge({ confirm: true }).deleted ? 'Your corrections file was deleted.' : 'Nothing to delete: you have no saved corrections.');
    break;
  }
  default: console.log('Usage: list | history <target> | add <target> "<text>" | remove <id> | export [file] | purge --confirm');
}
