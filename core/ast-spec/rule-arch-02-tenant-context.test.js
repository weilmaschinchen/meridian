// SPDX-License-Identifier: Apache-2.0
const goodFixtures = {
  good1: `
    function getData(db, tenantContext) {
      db.query('SELECT * FROM users');
    }
  `,
  good2: `
    const getData = (pool, tenantContext) => {
      pool.execute('SELECT ...');
    }
  `,
  good3: `
    class Repo {
      getData(tenantContext) {
        this.conn.query('SELECT ...');
      }
    }
  `,
};

const badFixtures = {
  bad1: `
    function getData(db) {
      db.query('SELECT ...');
    }
  `,
  bad2: `
    const handler = (pool) => {
      pool.execute('INSERT ...');
    }
  `,
  bad3: `
    class BadRepo {
      fetch() {
        this.conn.query('SELECT ...');
      }
    }
  `,
};

function runRule(fileContent) {
  // Pseudo: apply semgrep rule
  return semgrep.run('admin/cra/ast-spec/rule-arch-02-tenant-context.semgrep.yaml', fileContent);
}

Object.entries(goodFixtures).forEach(([name, code]) => {
  assert(runRule(code).length === 0, `Good fixture ${name} should pass`);
});
Object.entries(badFixtures).forEach(([name, code]) => {
  assert(runRule(code).length > 0, `Bad fixture ${name} should fail`);
});
console.log('All arch-02 tenant-context tests passed');
