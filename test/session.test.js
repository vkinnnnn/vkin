'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/main/brain/session');

test('active story can be set, read, and is cleared on reset', () => {
  const s = createSession({ ttlMinutes: 120 });
  assert.equal(s.activeStoryId, null);
  s.setActiveStory('STORY-1');
  assert.equal(s.activeStoryId, 'STORY-1');
  s.setActiveStory('');
  assert.equal(s.activeStoryId, null, 'empty clears it');
  s.setActiveStory('STORY-2');
  s.reset();
  assert.equal(s.activeStoryId, null, 'reset clears the active story');
});

test('active story is null once the session has expired', () => {
  let t = 0;
  const s = createSession({ ttlMinutes: 1, now: () => t });
  s.setActiveStory('STORY-1');
  assert.equal(s.activeStoryId, 'STORY-1');
  t += 2 * 60000; // past the TTL
  assert.equal(s.activeStoryId, null);
});
