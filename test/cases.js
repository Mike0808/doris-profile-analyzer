import { suite, test, assertEqual, assertTrue } from './runner.js';

suite('Runner smoke', () => {
  test('assertEqual on equal values passes', () => {
    assertEqual(1 + 1, 2);
  });
  test('assertTrue on truthy passes', () => {
    assertTrue([].length === 0);
  });
});
