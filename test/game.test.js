'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRoundLimit, createPlayer, scoreGuess, submitGuess } = require('../src/game');

test('duplicate digits consume only unmatched occurrences', () => {
  assert.deepEqual(scoreGuess('1123', '0111'), ['absent', 'correct', 'present', 'absent']);
  assert.deepEqual(scoreGuess('0012', '0000'), ['correct', 'correct', 'absent', 'absent']);
});

test('common 4 by 8 game has ten rounds', () => {
  assert.equal(calculateRoundLimit(4, 8), 10);
  assert.equal(calculateRoundLimit(1, 3), 6);
  assert.equal(calculateRoundLimit(6, 10), 13);
});

test('solved targets stop returning feedback', () => {
  const game = { status: 'playing', length: 3, roundLimit: 6, secrets: ['123', '456'] };
  const player = createPlayer('p1', '玩家', 2);
  assert.equal(submitGuess(game, player, '123', 100).finished, false);
  const second = submitGuess(game, player, '456', 200);
  assert.equal(second.won, true);
  assert.equal(second.feedback[0], null);
  assert.deepEqual(player.solvedAt, [1, 2]);
});

test('round exhaustion finishes a player', () => {
  const game = { status: 'playing', length: 3, roundLimit: 1, secrets: ['999'] };
  const player = createPlayer('p1', '玩家', 1);
  assert.equal(submitGuess(game, player, '123', 300).exhausted, true);
  assert.equal(player.finishedAt, 300);
});
