// rule-arch-14-cross-context-call.test.js
// Test skeleton for arch-14: Cross-Context-Direkt-Funktionsaufruf

const { runRule } = require('../test-utils/runrule');

// Good fixtures: imports from same context or shared modules
const goodFixtures = [
  {
    description: 'Import from same module utils',
    file: 'teamService.js',
    content: `
      import { calculate } from '../utils/helpers';
      calculate();
    `
  },
  {
    description: 'Import from @kursflow/shared package',
    file: 'teamService.js',
    content: `
      import { Logger } from '@kursflow/shared';
      Logger.log('test');
    `
  },
  {
    description: 'Import within same context (team) from deeper subdirectory',
    file: 'team/domain/userService.js',
    content: `
      import { getUser } from '../../team/domain/repository';
      getUser();
    `
  }
];

// Bad fixtures: cross-context import + direct function call
const badFixtures = [
  {
    description: 'team imports hvw/domain directly',
    file: 'team/domain/userService.js',
    content: `
      import { getBuilding } from '../../hvw/domain/building';
      getBuilding();
    `
  },
  {
    description: 'kurse imports assessment/service',
    file: 'kurse/domain/buchung.js',
    content: `
      import { analyze } from '../../assessment/service/analyzer';
      analyze();
    `
  }
];

describe('arch-14 Cross-Context Calls', () => {
  goodFixtures.forEach(({ description, content }) => {
    it(`should NOT flag: ${description}`, () => {
      const results = runRule('arch-14', content);
      expect(results).toHaveLength(0);
    });
  });

  badFixtures.forEach(({ description, content }) => {
    it(`should flag: ${description}`, () => {
      const results = runRule('arch-14', content);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('arch-14');
    });
  });
});
