'use strict';
// Shared fixtures for the vkin-runtime tests: a tiny synthetic career profile (written to a temp dir), a config
// without any real profile, and an engine factory. No network, no paid calls, nothing from the real profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngine } = require('../src/main/engine');
const { createRegistry } = require('../src/main/providers/registry');

const CAREER = `---
name: CareerPro
owner: Sam Rivera
updated: 2026-10-13
---

# Sam Rivera: CareerPro Profile

## 6. Experience

### [EXP-001] Acme Analytics: Data Analyst
**Type:** Paid employment
**When:** Jan 2022 to Mar 2024
**Where:** Acme Analytics, Boston, MA
**Team:** Individual contributor
**Stack:** Tableau, SQL

**Summary:** Built Tableau dashboards that replaced 4 hours of daily reporting.

**Situation:** Reports were assembled by hand every morning.
**Task:** Give the team a clear view of KPIs.
**Action:**
- Built dashboards.
**Result:**
- Downtime dropped 28%.

**Keywords:** Data Analyst, SQL, Dashboards
`;

let dir = null;
function careerFile() {
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-runtime-'));
    fs.writeFileSync(path.join(dir, 'CareerPro.md'), CAREER);
  }
  return path.join(dir, 'CareerPro.md');
}

const LLM = { routes: { default: 'Qwen/Qwen3-235B-A22B-Instruct-2507', deep: 'nvidia/Nemotron-3-Ultra-550b-a55b', personal: '' }, enableDeepRoute: false, deepComplexityThreshold: 0.6, deepMaxShare: 0.05 };
const NOW = Date.parse('2026-10-28T14:00:00Z');

/** @param {{ profile?: any, withProfile?: boolean, flags?: any, now?: () => number, readFile?: any }} [o] */
function makeEngine({ profile = {}, withProfile = true, flags = {}, now = () => NOW, readFile } = {}) {
  const config = {
    llm: LLM,
    answer: { length: 'short' },
    meeting: { enabled: false },
    profile: profile === null ? undefined : { ...(withProfile ? { careerPro: careerFile() } : {}), displayName: 'Sam', ...profile },
  };
  const registry = createRegistry(config, {});
  return createEngine({ config, root: path.join(__dirname, '..'), registry, flags, env: {}, now, ...(readFile ? { readFile } : {}) });
}

const userMsg = (built) => built.messages[1].content;

module.exports = { makeEngine, careerFile, userMsg, NOW, CAREER };
