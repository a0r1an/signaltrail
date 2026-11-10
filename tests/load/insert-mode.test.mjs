import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessInsertMode, parseInsertEvents } from './insert-mode.mjs';

const body = (async) =>
  JSON.stringify({
    data: [
      { event: 'InsertQuery', value: '1200' },
      { event: 'AsyncInsertQuery', value: String(async) },
    ],
  });

test('parses cumulative ClickHouse insert counters', () => {
  assert.deepEqual(parseInsertEvents(body(900)), { InsertQuery: 1200, AsyncInsertQuery: 900 });
});

test('async profiles must observe server-side async inserts', () => {
  assert.deepEqual(assessInsertMode({ asyncInsert: true, events: { AsyncInsertQuery: 900 } }), []);
  assert.deepEqual(assessInsertMode({ asyncInsert: true, events: { AsyncInsertQuery: 0 } }), [
    'Async insert mode was not observed',
  ]);
  assert.deepEqual(assessInsertMode({ asyncInsert: true, events: {} }), [
    'Async insert mode was not observed',
  ]);
});

test('synchronous profiles must not use async inserts', () => {
  assert.deepEqual(assessInsertMode({ asyncInsert: false, events: { AsyncInsertQuery: 0 } }), []);
  assert.deepEqual(assessInsertMode({ asyncInsert: false, events: {} }), []);
  assert.deepEqual(assessInsertMode({ asyncInsert: false, events: { AsyncInsertQuery: 3 } }), [
    'Unexpected async inserts in a synchronous profile',
  ]);
});
